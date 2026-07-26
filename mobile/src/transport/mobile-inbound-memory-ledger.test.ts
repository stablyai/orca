import { describe, expect, it } from 'vitest'
import {
  createMobileInboundMemoryLedger,
  MOBILE_PROCESS_INBOUND_MAX_RETAINED_BYTES,
  MOBILE_PROCESS_INBOUND_MAX_RETAINED_FRAMES
} from './mobile-inbound-memory-ledger'

describe('mobile inbound memory ledger', () => {
  it('uses a process ceiling that preserves two full ordinary queue budgets', () => {
    expect(MOBILE_PROCESS_INBOUND_MAX_RETAINED_BYTES).toBe(192 * 1024 * 1024)
    expect(MOBILE_PROCESS_INBOUND_MAX_RETAINED_FRAMES).toBe(256)
  })

  it('makes claims idempotently releasable', () => {
    const ledger = createMobileInboundMemoryLedger(5)
    const release = ledger.claim(5)
    expect(release).not.toBeNull()
    expect(ledger.claim(1)).toBeNull()

    release!()
    release!()

    expect(ledger.evidence()).toEqual({
      claimCount: 0,
      maxRetainedBytes: 5,
      maxRetainedFrames: MOBILE_PROCESS_INBOUND_MAX_RETAINED_FRAMES,
      retainedBytes: 0
    })
  })

  it('bounds aggregate zero-byte claims independently of the byte ceiling', () => {
    const ledger = createMobileInboundMemoryLedger(5, 2)
    const releaseFirst = ledger.claim(0)
    const releaseSecond = ledger.claim(0)

    expect(releaseFirst).not.toBeNull()
    expect(releaseSecond).not.toBeNull()
    expect(ledger.claim(0)).toBeNull()

    releaseFirst!()
    releaseSecond!()
  })
})
