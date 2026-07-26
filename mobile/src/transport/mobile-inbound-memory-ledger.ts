export const MOBILE_PROCESS_INBOUND_MAX_RETAINED_BYTES = 192 * 1024 * 1024
export const MOBILE_PROCESS_INBOUND_MAX_RETAINED_FRAMES = 256

export type MobileInboundMemoryLedgerEvidence = {
  claimCount: number
  maxRetainedFrames: number
  maxRetainedBytes: number
  retainedBytes: number
}

export type MobileInboundMemoryLedger = {
  claim(bytes: number): (() => void) | null
  evidence(): MobileInboundMemoryLedgerEvidence
}

export function createMobileInboundMemoryLedger(
  maxRetainedBytes: number,
  maxRetainedFrames = MOBILE_PROCESS_INBOUND_MAX_RETAINED_FRAMES
): MobileInboundMemoryLedger {
  if (
    !Number.isFinite(maxRetainedBytes) ||
    maxRetainedBytes < 1 ||
    !Number.isInteger(maxRetainedFrames) ||
    maxRetainedFrames < 1
  ) {
    throw new Error('Mobile inbound memory limit must be positive')
  }
  let retainedBytes = 0
  let claimCount = 0
  return {
    claim(bytes): (() => void) | null {
      if (!Number.isFinite(bytes) || bytes < 0) {
        return null
      }
      if (claimCount >= maxRetainedFrames || retainedBytes + bytes > maxRetainedBytes) {
        return null
      }
      retainedBytes += bytes
      claimCount += 1
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        retainedBytes -= bytes
        claimCount -= 1
      }
    },
    evidence(): MobileInboundMemoryLedgerEvidence {
      return { claimCount, maxRetainedBytes, maxRetainedFrames, retainedBytes }
    }
  }
}

export const processMobileInboundMemoryLedger = createMobileInboundMemoryLedger(
  MOBILE_PROCESS_INBOUND_MAX_RETAINED_BYTES
)
