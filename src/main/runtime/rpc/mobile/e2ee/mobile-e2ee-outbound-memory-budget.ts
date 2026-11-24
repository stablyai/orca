export const MOBILE_E2EE_PROCESS_MAX_BUFFERED_BYTES = 32 * 1024 * 1024
export const MOBILE_E2EE_PROCESS_MAX_QUEUED_BYTES = 128 * 1024 * 1024
export const MOBILE_E2EE_PROCESS_MAX_QUEUED_FRAMES = 16_384
export const MOBILE_E2EE_PROCESS_MAX_SOCKET_SOURCES = 256

export type MobileE2EEOutboundSocketMemory = {
  canSend: (bytes: number) => boolean
  release: () => void
}

export type MobileE2EEOutboundMemoryBudget = {
  claimQueuedBytes: (bytes: number) => (() => void) | null
  registerBufferedAmount: (
    readBufferedAmount: () => number
  ) => MobileE2EEOutboundSocketMemory | null
  evidence: () => {
    bufferedBytes: number
    queuedBytes: number
    queuedFrames: number
    sockets: number
  }
}

export function createMobileE2EEOutboundMemoryBudget(options?: {
  maxBufferedBytes?: number
  maxQueuedBytes?: number
  maxQueuedFrames?: number
  maxSocketSources?: number
}): MobileE2EEOutboundMemoryBudget {
  const maxBufferedBytes = options?.maxBufferedBytes ?? MOBILE_E2EE_PROCESS_MAX_BUFFERED_BYTES
  const maxQueuedBytes = options?.maxQueuedBytes ?? MOBILE_E2EE_PROCESS_MAX_QUEUED_BYTES
  const maxQueuedFrames = options?.maxQueuedFrames ?? MOBILE_E2EE_PROCESS_MAX_QUEUED_FRAMES
  const maxSocketSources = options?.maxSocketSources ?? MOBILE_E2EE_PROCESS_MAX_SOCKET_SOURCES
  const bufferedSources = new Set<() => number>()
  let queuedBytes = 0
  let queuedFrames = 0

  const bufferedBytes = (): number => {
    let total = 0
    for (const read of bufferedSources) {
      try {
        const value = read()
        if (Number.isFinite(value) && value > 0) {
          total += value
        }
      } catch {
        // Closed sockets can reject a late read before channel teardown releases the source.
      }
    }
    return total
  }

  return {
    claimQueuedBytes(bytes): (() => void) | null {
      if (
        !Number.isFinite(bytes) ||
        bytes < 0 ||
        queuedFrames >= maxQueuedFrames ||
        queuedBytes + bytes > maxQueuedBytes
      ) {
        return null
      }
      queuedBytes += bytes
      queuedFrames += 1
      return createRelease(() => {
        queuedBytes -= bytes
        queuedFrames -= 1
      })
    },
    registerBufferedAmount(readBufferedAmount): MobileE2EEOutboundSocketMemory | null {
      if (bufferedSources.size >= maxSocketSources) {
        return null
      }
      bufferedSources.add(readBufferedAmount)
      let registered = true
      return {
        canSend: (bytes) =>
          registered &&
          Number.isFinite(bytes) &&
          bytes >= 0 &&
          bytes <= maxBufferedBytes - bufferedBytes(),
        release: createRelease(() => {
          registered = false
          bufferedSources.delete(readBufferedAmount)
        })
      }
    },
    evidence: () => ({
      bufferedBytes: bufferedBytes(),
      queuedBytes,
      queuedFrames,
      sockets: bufferedSources.size
    })
  }
}

function createRelease(release: () => void): () => void {
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    release()
  }
}
