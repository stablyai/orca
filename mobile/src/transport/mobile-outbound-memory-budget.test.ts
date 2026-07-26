import { describe, expect, it } from 'vitest'
import {
  createMobileOutboundMemoryBudget,
  MOBILE_OUTBOUND_MAX_FRAME_BYTES,
  MOBILE_PROCESS_OUTBOUND_MAX_BUFFERED_BYTES,
  MOBILE_PROCESS_OUTBOUND_MAX_IN_FLIGHT_FRAMES,
  MOBILE_PROCESS_OUTBOUND_MAX_QUEUED_BYTES,
  MOBILE_PROCESS_OUTBOUND_MAX_QUEUED_FRAMES,
  MOBILE_PROCESS_OUTBOUND_MAX_SOCKET_SOURCES
} from './mobile-outbound-memory-budget'

describe('mobile outbound memory budget', () => {
  it('keeps ordinary two-socket bursts within explicit process ceilings', () => {
    expect(MOBILE_PROCESS_OUTBOUND_MAX_BUFFERED_BYTES).toBe(16 * 1024 * 1024)
    expect(MOBILE_PROCESS_OUTBOUND_MAX_IN_FLIGHT_FRAMES).toBe(16_384)
    expect(MOBILE_PROCESS_OUTBOUND_MAX_QUEUED_BYTES).toBe(128 * 1024 * 1024)
    expect(MOBILE_PROCESS_OUTBOUND_MAX_QUEUED_FRAMES).toBe(16_384)
    expect(MOBILE_PROCESS_OUTBOUND_MAX_SOCKET_SOURCES).toBe(64)
    expect(MOBILE_OUTBOUND_MAX_FRAME_BYTES).toBe(8 * 1024 * 1024)
  })

  it('sums native bufferedAmount across registered physical sockets', () => {
    const budget = createMobileOutboundMemoryBudget({ maxBufferedBytes: 10 })
    let first = 4
    const firstSource = budget.registerBufferedAmount(() => first)
    const secondSource = budget.registerBufferedAmount(() => 6)
    expect(firstSource.canSend(0)).toBe(true)

    first = 5
    expect(firstSource.canSend(0)).toBe(false)
    secondSource.release()
    firstSource.release()
    expect(budget.evidence()).toMatchObject({ bufferedBytes: 0, bufferedSourceCount: 0 })
  })

  it('reserves room for the prospective native frame before allowing a send', () => {
    const budget = createMobileOutboundMemoryBudget({ maxBufferedBytes: 10 })
    const source = budget.registerBufferedAmount(() => 6)

    expect(source.canSend(4)).toBe(true)
    expect(source.canSend(5)).toBe(false)
  })

  it('counts unacknowledged frames when React Native does not expose bufferedAmount', () => {
    const budget = createMobileOutboundMemoryBudget({ maxBufferedBytes: 10 })
    const source = budget.registerBufferedAmount(() => Number.NaN)
    const release = source.claimInFlightBytes(7)

    expect(release).not.toBeNull()
    expect(source.canSend(4)).toBe(false)
    expect(budget.evidence()).toMatchObject({
      bufferedBytes: 7,
      inFlightBytes: 7,
      inFlightClaimCount: 1
    })

    release!()
    expect(source.canSend(10)).toBe(true)
  })

  it('caps sent-frame claims and retired socket readers independently', () => {
    const budget = createMobileOutboundMemoryBudget({
      maxBufferedBytes: 10,
      maxBufferedSources: 1,
      maxInFlightFrames: 1
    })
    const source = budget.registerBufferedAmount(() => 0)
    const release = source.claimInFlightBytes(0)

    expect(release).not.toBeNull()
    expect(source.claimInFlightBytes(0)).toBeNull()
    expect(budget.canRegisterBufferedAmount()).toBe(false)
    expect(() => budget.registerBufferedAmount(() => 0)).toThrow(
      'Mobile outbound socket tracking limit exceeded'
    )

    release!()
    source.release()
    expect(budget.canRegisterBufferedAmount()).toBe(true)
  })

  it('bounds aggregate JavaScript backlog and releases claims idempotently', () => {
    const budget = createMobileOutboundMemoryBudget({ maxQueuedBytes: 5 })
    const release = budget.claimQueuedBytes(5)
    expect(release).not.toBeNull()
    expect(budget.claimQueuedBytes(1)).toBeNull()

    release!()
    release!()

    expect(budget.evidence()).toMatchObject({ queuedBytes: 0, queuedClaimCount: 0 })
  })

  it('bounds aggregate zero-byte claims independently of the byte ceiling', () => {
    const budget = createMobileOutboundMemoryBudget({ maxQueuedBytes: 5, maxQueuedFrames: 2 })
    const releaseFirst = budget.claimQueuedBytes(0)
    const releaseSecond = budget.claimQueuedBytes(0)

    expect(releaseFirst).not.toBeNull()
    expect(releaseSecond).not.toBeNull()
    expect(budget.claimQueuedBytes(0)).toBeNull()

    releaseFirst!()
    releaseSecond!()
  })
})
