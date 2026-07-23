import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMobileOutboundMemoryBudget } from './mobile-outbound-memory-budget'
import {
  createMobileOutboundSocketLedger,
  MOBILE_OUTBOUND_SOCKET_RETIRE_TIMEOUT_MS
} from './mobile-outbound-socket-ledger'

describe('mobile outbound socket ledger', () => {
  afterEach(() => vi.useRealTimers())

  it('releases only the matching delivered frame while the socket stays open', () => {
    const budget = createMobileOutboundMemoryBudget({ maxBufferedBytes: 10 })
    const ledger = createMobileOutboundSocketLedger({
      memoryBudget: budget,
      readBufferedAmount: () => Number.NaN
    })

    expect(ledger.claimSentBytes(4, 'rpc-1')).not.toBeNull()
    expect(ledger.claimSentBytes(5, 'rpc-2')).not.toBeNull()
    expect(ledger.canSend(2)).toBe(false)

    ledger.acknowledge('rpc-1')

    expect(budget.evidence()).toMatchObject({ inFlightBytes: 5, inFlightClaimCount: 1 })
    expect(ledger.canSend(5)).toBe(true)
  })

  it('keeps unacknowledged bytes counted across logical disposal until native close', () => {
    const budget = createMobileOutboundMemoryBudget({ maxBufferedBytes: 10 })
    const ledger = createMobileOutboundSocketLedger({
      memoryBudget: budget,
      readBufferedAmount: () => Number.NaN
    })
    expect(ledger.claimSentBytes(6, 'rpc-1')).not.toBeNull()

    expect(budget.evidence()).toMatchObject({ bufferedBytes: 6, bufferedSourceCount: 1 })

    ledger.socketClosed()
    ledger.socketClosed()
    expect(budget.evidence()).toMatchObject({
      bufferedBytes: 0,
      bufferedSourceCount: 0,
      inFlightClaimCount: 0
    })
  })

  it('releases a retired socket after a missing native close callback', () => {
    vi.useFakeTimers()
    const budget = createMobileOutboundMemoryBudget({ maxBufferedBytes: 10 })
    const ledger = createMobileOutboundSocketLedger({
      memoryBudget: budget,
      readBufferedAmount: () => Number.NaN
    })
    expect(ledger.claimSentBytes(6, 'rpc-1')).not.toBeNull()

    ledger.retire()
    vi.advanceTimersByTime(MOBILE_OUTBOUND_SOCKET_RETIRE_TIMEOUT_MS - 1)
    expect(budget.evidence().bufferedSourceCount).toBe(1)

    vi.advanceTimersByTime(1)
    expect(budget.evidence()).toMatchObject({
      bufferedBytes: 0,
      bufferedSourceCount: 0,
      inFlightClaimCount: 0
    })
  })

  it('settles unkeyed frames after a runtime reports two drained polls', () => {
    vi.useFakeTimers()
    const budget = createMobileOutboundMemoryBudget({ maxBufferedBytes: 10 })
    const ledger = createMobileOutboundSocketLedger({
      memoryBudget: budget,
      readBufferedAmount: () => 0
    })
    expect(ledger.claimSentBytes(6)).not.toBeNull()

    vi.advanceTimersByTime(50)

    expect(budget.evidence()).toMatchObject({ inFlightBytes: 0, inFlightClaimCount: 0 })
    ledger.socketClosed()
  })

  it('requires two fresh drained polls after another unkeyed frame is sent', () => {
    vi.useFakeTimers()
    const budget = createMobileOutboundMemoryBudget({ maxBufferedBytes: 10 })
    const ledger = createMobileOutboundSocketLedger({
      memoryBudget: budget,
      readBufferedAmount: () => 0
    })
    expect(ledger.claimSentBytes(4)).not.toBeNull()

    vi.advanceTimersByTime(25)
    expect(ledger.claimSentBytes(2)).not.toBeNull()
    vi.advanceTimersByTime(25)

    expect(budget.evidence()).toMatchObject({ inFlightBytes: 6, inFlightClaimCount: 2 })
    vi.advanceTimersByTime(25)
    expect(budget.evidence()).toMatchObject({ inFlightBytes: 0, inFlightClaimCount: 0 })
    ledger.socketClosed()
  })

  it('keeps unkeyed React Native claims until close when bufferedAmount is unavailable', () => {
    vi.useFakeTimers()
    const budget = createMobileOutboundMemoryBudget({ maxBufferedBytes: 10 })
    const ledger = createMobileOutboundSocketLedger({
      memoryBudget: budget,
      readBufferedAmount: () => Number.NaN
    })
    expect(ledger.claimSentBytes(6)).not.toBeNull()

    vi.advanceTimersByTime(1_000)
    expect(budget.evidence()).toMatchObject({ inFlightBytes: 6, inFlightClaimCount: 1 })

    ledger.socketClosed()
    expect(budget.evidence()).toMatchObject({ inFlightBytes: 0, inFlightClaimCount: 0 })
  })
})
