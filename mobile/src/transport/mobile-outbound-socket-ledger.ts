import type { MobileOutboundMemoryBudget } from './mobile-outbound-memory-budget'

type InFlightClaim = {
  acknowledgementKey?: string
  releaseBytes: () => void
}

export const MOBILE_OUTBOUND_SOCKET_RETIRE_TIMEOUT_MS = 30_000
const NATIVE_DRAIN_POLL_MS = 25

export type MobileOutboundSocketLedger = {
  acknowledge(key: string): void
  canSend(bytes: number): boolean
  claimSentBytes(bytes: number, acknowledgementKey?: string): (() => void) | null
  retire(): void
  socketClosed(): void
}

export function createMobileOutboundSocketLedger(args: {
  memoryBudget: MobileOutboundMemoryBudget
  readBufferedAmount: () => number
}): MobileOutboundSocketLedger {
  const socketMemory = args.memoryBudget.registerBufferedAmount(args.readBufferedAmount)
  const activeClaims = new Set<InFlightClaim>()
  const anonymousClaims = new Set<InFlightClaim>()
  const claimsByAcknowledgement = new Map<string, Set<InFlightClaim>>()
  let drainTimer: ReturnType<typeof setTimeout> | null = null
  let retireTimer: ReturnType<typeof setTimeout> | null = null
  let consecutiveZeroDrainPolls = 0
  let closed = false

  const settleClaim = (claim: InFlightClaim): void => {
    if (!activeClaims.delete(claim)) {
      return
    }
    claim.releaseBytes()
    if (claim.acknowledgementKey === undefined) {
      anonymousClaims.delete(claim)
      return
    }
    const keyed = claimsByAcknowledgement.get(claim.acknowledgementKey)
    keyed?.delete(claim)
    if (keyed?.size === 0) {
      claimsByAcknowledgement.delete(claim.acknowledgementKey)
    }
  }

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null): void => {
    if (timer) {
      clearTimeout(timer)
    }
  }

  const pollNativeDrain = (): void => {
    drainTimer = null
    if (closed || anonymousClaims.size === 0) {
      return
    }
    let bufferedAmount: number
    try {
      bufferedAmount = args.readBufferedAmount()
    } catch {
      return
    }
    // React Native leaves this undefined; keyed application ACKs remain the authoritative path there.
    if (!Number.isFinite(bufferedAmount) || bufferedAmount < 0) {
      return
    }
    consecutiveZeroDrainPolls = bufferedAmount === 0 ? consecutiveZeroDrainPolls + 1 : 0
    if (consecutiveZeroDrainPolls >= 2) {
      for (const claim of anonymousClaims) {
        settleClaim(claim)
      }
      return
    }
    drainTimer = setTimeout(pollNativeDrain, NATIVE_DRAIN_POLL_MS)
    unrefTimer(drainTimer)
  }

  const scheduleNativeDrainPoll = (): void => {
    if (drainTimer || closed) {
      return
    }
    drainTimer = setTimeout(pollNativeDrain, NATIVE_DRAIN_POLL_MS)
    unrefTimer(drainTimer)
  }

  const closeLedger = (): void => {
    if (closed) {
      return
    }
    closed = true
    clearTimer(drainTimer)
    clearTimer(retireTimer)
    drainTimer = null
    retireTimer = null
    for (const claim of activeClaims) {
      settleClaim(claim)
    }
    anonymousClaims.clear()
    claimsByAcknowledgement.clear()
    socketMemory.release()
  }

  return {
    acknowledge(key): void {
      const claims = claimsByAcknowledgement.get(key)
      if (!claims) {
        return
      }
      for (const claim of claims) {
        settleClaim(claim)
      }
    },
    canSend: (bytes) => socketMemory.canSend(bytes),
    claimSentBytes(bytes, acknowledgementKey): (() => void) | null {
      const releaseBytes = socketMemory.claimInFlightBytes(bytes)
      if (!releaseBytes) {
        return null
      }
      const claim: InFlightClaim = { acknowledgementKey, releaseBytes }
      activeClaims.add(claim)
      if (acknowledgementKey === undefined) {
        anonymousClaims.add(claim)
        consecutiveZeroDrainPolls = 0
        scheduleNativeDrainPoll()
      } else {
        let claims = claimsByAcknowledgement.get(acknowledgementKey)
        if (!claims) {
          claims = new Set()
          claimsByAcknowledgement.set(acknowledgementKey, claims)
        }
        claims.add(claim)
      }
      return () => settleClaim(claim)
    },
    retire(): void {
      if (closed || retireTimer) {
        return
      }
      retireTimer = setTimeout(closeLedger, MOBILE_OUTBOUND_SOCKET_RETIRE_TIMEOUT_MS)
      unrefTimer(retireTimer)
    },
    socketClosed: closeLedger
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const nodeTimer = timer as unknown as { unref?: () => void }
  nodeTimer.unref?.()
}
