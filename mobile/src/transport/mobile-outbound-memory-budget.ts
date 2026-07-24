export const MOBILE_PROCESS_OUTBOUND_MAX_BUFFERED_BYTES = 16 * 1024 * 1024
export const MOBILE_PROCESS_OUTBOUND_MAX_QUEUED_BYTES = 128 * 1024 * 1024
export const MOBILE_PROCESS_OUTBOUND_MAX_QUEUED_FRAMES = 16_384
export const MOBILE_PROCESS_OUTBOUND_MAX_IN_FLIGHT_FRAMES = 16_384
export const MOBILE_PROCESS_OUTBOUND_MAX_SOCKET_SOURCES = 64
export const MOBILE_OUTBOUND_MAX_FRAME_BYTES = 8 * 1024 * 1024

export type MobileOutboundMemoryBudgetEvidence = {
  bufferedBytes: number
  bufferedSourceCount: number
  inFlightBytes: number
  inFlightClaimCount: number
  queuedBytes: number
  queuedClaimCount: number
}

export type MobileOutboundSocketMemory = {
  canSend(bytes: number): boolean
  claimInFlightBytes(bytes: number): (() => void) | null
  release(): void
}

export type MobileOutboundMemoryBudget = {
  canRegisterBufferedAmount(): boolean
  claimQueuedBytes(bytes: number): (() => void) | null
  evidence(): MobileOutboundMemoryBudgetEvidence
  registerBufferedAmount(readBufferedAmount: () => number): MobileOutboundSocketMemory
}

export function createMobileOutboundMemoryBudget(options?: {
  maxBufferedBytes?: number
  maxBufferedSources?: number
  maxInFlightFrames?: number
  maxQueuedBytes?: number
  maxQueuedFrames?: number
}): MobileOutboundMemoryBudget {
  const maxBufferedBytes = options?.maxBufferedBytes ?? MOBILE_PROCESS_OUTBOUND_MAX_BUFFERED_BYTES
  const maxBufferedSources =
    options?.maxBufferedSources ?? MOBILE_PROCESS_OUTBOUND_MAX_SOCKET_SOURCES
  const maxInFlightFrames =
    options?.maxInFlightFrames ?? MOBILE_PROCESS_OUTBOUND_MAX_IN_FLIGHT_FRAMES
  const maxQueuedBytes = options?.maxQueuedBytes ?? MOBILE_PROCESS_OUTBOUND_MAX_QUEUED_BYTES
  const maxQueuedFrames = options?.maxQueuedFrames ?? MOBILE_PROCESS_OUTBOUND_MAX_QUEUED_FRAMES
  if (
    !Number.isFinite(maxBufferedBytes) ||
    maxBufferedBytes < 1 ||
    !Number.isInteger(maxBufferedSources) ||
    maxBufferedSources < 1 ||
    !Number.isInteger(maxInFlightFrames) ||
    maxInFlightFrames < 1 ||
    !Number.isFinite(maxQueuedBytes) ||
    maxQueuedBytes < 1 ||
    !Number.isInteger(maxQueuedFrames) ||
    maxQueuedFrames < 1
  ) {
    throw new Error('Mobile outbound memory limits must be positive')
  }
  type BufferedSource = {
    inFlightBytes: number
    inFlightClaimCount: number
    readBufferedAmount: () => number
  }
  const bufferedSources = new Set<BufferedSource>()
  let queuedBytes = 0
  let queuedClaimCount = 0

  const bufferedBytes = (): number => {
    let total = 0
    for (const source of bufferedSources) {
      let observed = 0
      try {
        const value = source.readBufferedAmount()
        if (Number.isFinite(value) && value > 0) {
          observed = value
        }
      } catch {
        // Closed native sockets may reject late reads; their close path unregisters them.
      }
      // Some runtimes update bufferedAmount asynchronously, so unacknowledged
      // claims remain additive instead of assuming the native value includes them.
      total += observed + source.inFlightBytes
    }
    return total
  }

  const inFlightClaimCount = (): number => {
    let count = 0
    for (const source of bufferedSources) {
      count += source.inFlightClaimCount
    }
    return count
  }

  const inFlightBytes = (): number => {
    let total = 0
    for (const source of bufferedSources) {
      total += source.inFlightBytes
    }
    return total
  }

  return {
    canRegisterBufferedAmount: () => bufferedSources.size < maxBufferedSources,
    claimQueuedBytes(bytes): (() => void) | null {
      if (
        !Number.isFinite(bytes) ||
        bytes < 0 ||
        queuedClaimCount >= maxQueuedFrames ||
        queuedBytes + bytes > maxQueuedBytes
      ) {
        return null
      }
      queuedBytes += bytes
      queuedClaimCount += 1
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        queuedBytes -= bytes
        queuedClaimCount -= 1
      }
    },
    evidence(): MobileOutboundMemoryBudgetEvidence {
      return {
        bufferedBytes: bufferedBytes(),
        bufferedSourceCount: bufferedSources.size,
        inFlightBytes: inFlightBytes(),
        inFlightClaimCount: inFlightClaimCount(),
        queuedBytes,
        queuedClaimCount
      }
    },
    registerBufferedAmount(readBufferedAmount): MobileOutboundSocketMemory {
      if (bufferedSources.size >= maxBufferedSources) {
        throw new Error('Mobile outbound socket tracking limit exceeded')
      }
      const source: BufferedSource = {
        inFlightBytes: 0,
        inFlightClaimCount: 0,
        readBufferedAmount
      }
      bufferedSources.add(source)
      let registered = true
      return {
        canSend(bytes): boolean {
          return (
            registered &&
            Number.isFinite(bytes) &&
            bytes >= 0 &&
            inFlightClaimCount() < maxInFlightFrames &&
            bytes <= maxBufferedBytes - bufferedBytes()
          )
        },
        claimInFlightBytes(bytes): (() => void) | null {
          if (!this.canSend(bytes)) {
            return null
          }
          source.inFlightBytes += bytes
          source.inFlightClaimCount += 1
          let released = false
          return () => {
            if (released) {
              return
            }
            released = true
            if (registered) {
              source.inFlightBytes -= bytes
              source.inFlightClaimCount -= 1
            }
          }
        },
        release(): void {
          if (!registered) {
            return
          }
          registered = false
          bufferedSources.delete(source)
          source.inFlightBytes = 0
          source.inFlightClaimCount = 0
        }
      }
    }
  }
}

export const processMobileOutboundMemoryBudget = createMobileOutboundMemoryBudget()
