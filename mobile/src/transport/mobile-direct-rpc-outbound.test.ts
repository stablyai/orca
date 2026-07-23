import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMobileDirectRpcOutbound } from './mobile-direct-rpc-outbound'
import { createMobileOutboundMemoryBudget } from './mobile-outbound-memory-budget'
import { MOBILE_OUTBOUND_SOCKET_RETIRE_TIMEOUT_MS } from './mobile-outbound-socket-ledger'

vi.mock('./e2ee', () => ({
  encrypt: (plaintext: string) => `encrypted:${plaintext}`
}))

function socket() {
  return {
    OPEN: 1,
    bufferedAmount: 0,
    readyState: 1,
    send: vi.fn()
  }
}

describe('mobile direct RPC outbound queue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('parks in FIFO order while another socket owns aggregate native buffer credit', () => {
    const budget = createMobileOutboundMemoryBudget({
      maxBufferedBytes: 100,
      maxQueuedBytes: 1_000
    })
    const firstSocket = socket()
    const secondSocket = socket()
    firstSocket.bufferedAmount = 60
    secondSocket.bufferedAmount = 41
    const first = createMobileDirectRpcOutbound({
      socket: firstSocket,
      isActive: () => true,
      onOverflow: vi.fn(),
      memoryBudget: budget
    })
    const second = createMobileDirectRpcOutbound({
      socket: secondSocket,
      isActive: () => true,
      onOverflow: vi.fn(),
      memoryBudget: budget
    })

    expect(first.enqueue('one', new Uint8Array(32), 'rpc-1')).toBe(true)
    expect(first.enqueue('two', new Uint8Array(32), 'rpc-2')).toBe(true)
    expect(firstSocket.send).not.toHaveBeenCalled()
    expect(budget.evidence().queuedClaimCount).toBe(2)

    secondSocket.bufferedAmount = 0
    firstSocket.bufferedAmount = 0
    vi.advanceTimersByTime(25)

    expect(firstSocket.send.mock.calls.map(([frame]) => frame)).toEqual(['encrypted:one'])
    first.acknowledge('rpc-1')
    vi.advanceTimersByTime(25)
    expect(firstSocket.send.mock.calls.map(([frame]) => frame)).toEqual([
      'encrypted:one',
      'encrypted:two'
    ])
    first.acknowledge('rpc-2')
    expect(budget.evidence()).toMatchObject({ queuedBytes: 0, queuedClaimCount: 0 })
    first.dispose()
    second.dispose()
    expect(budget.evidence().bufferedSourceCount).toBe(2)
    first.socketClosed()
    second.socketClosed()
    expect(budget.evidence().bufferedSourceCount).toBe(0)
  })

  it('fails the offending connection when aggregate JavaScript admission is exhausted', () => {
    const budget = createMobileOutboundMemoryBudget({
      maxBufferedBytes: 1,
      maxQueuedBytes: 10
    })
    const targetSocket = socket()
    targetSocket.bufferedAmount = 2
    const onOverflow = vi.fn()
    const outbound = createMobileDirectRpcOutbound({
      socket: targetSocket,
      isActive: () => true,
      onOverflow,
      memoryBudget: budget
    })

    expect(outbound.enqueue('payload', new Uint8Array(32))).toBe(false)

    expect(onOverflow).toHaveBeenCalledOnce()
    expect(targetSocket.send).not.toHaveBeenCalled()
    expect(budget.evidence()).toMatchObject({
      bufferedSourceCount: 1,
      queuedBytes: 0,
      queuedClaimCount: 0
    })
    outbound.dispose()
    expect(budget.evidence().bufferedSourceCount).toBe(1)
    outbound.socketClosed()
    expect(budget.evidence().bufferedSourceCount).toBe(0)
  })

  it('uses matching RPC responses as backpressure when bufferedAmount is unavailable', () => {
    const budget = createMobileOutboundMemoryBudget({
      maxBufferedBytes: 100,
      maxQueuedBytes: 1_000
    })
    const targetSocket = socket()
    targetSocket.bufferedAmount = Number.NaN
    const outbound = createMobileDirectRpcOutbound({
      socket: targetSocket,
      isActive: () => true,
      onOverflow: vi.fn(),
      memoryBudget: budget
    })

    expect(outbound.enqueue('one', new Uint8Array(32), 'rpc-1')).toBe(true)
    expect(outbound.enqueue('two', new Uint8Array(32), 'rpc-2')).toBe(true)
    expect(targetSocket.send.mock.calls.map(([frame]) => frame)).toEqual(['encrypted:one'])

    outbound.acknowledge('rpc-1')
    vi.advanceTimersByTime(25)
    expect(targetSocket.send.mock.calls.map(([frame]) => frame)).toEqual([
      'encrypted:one',
      'encrypted:two'
    ])
    expect(budget.evidence()).toMatchObject({ inFlightBytes: 60, inFlightClaimCount: 1 })

    outbound.socketClosed()
    expect(budget.evidence()).toMatchObject({ bufferedBytes: 0, bufferedSourceCount: 0 })
  })

  it('reports synchronous native send failure instead of marking a stream as sent', () => {
    const budget = createMobileOutboundMemoryBudget({ maxBufferedBytes: 100 })
    const targetSocket = socket()
    targetSocket.send.mockImplementation(() => {
      throw new Error('native send failed')
    })
    const onOverflow = vi.fn()
    const outbound = createMobileDirectRpcOutbound({
      socket: targetSocket,
      isActive: () => true,
      onOverflow,
      memoryBudget: budget
    })

    expect(outbound.enqueue('one', new Uint8Array(32), 'rpc-1')).toBe(false)
    expect(onOverflow).toHaveBeenCalledOnce()
    expect(budget.evidence()).toMatchObject({ inFlightBytes: 0, inFlightClaimCount: 0 })
    outbound.socketClosed()
  })

  it('allows another socket after a retired socket never reports close', () => {
    const budget = createMobileOutboundMemoryBudget({
      maxBufferedBytes: 100,
      maxBufferedSources: 1
    })
    const first = createMobileDirectRpcOutbound({
      socket: socket(),
      isActive: () => true,
      onOverflow: vi.fn(),
      memoryBudget: budget
    })

    first.dispose()
    expect(budget.canRegisterBufferedAmount()).toBe(false)
    vi.advanceTimersByTime(MOBILE_OUTBOUND_SOCKET_RETIRE_TIMEOUT_MS)
    expect(budget.canRegisterBufferedAmount()).toBe(true)

    const second = createMobileDirectRpcOutbound({
      socket: socket(),
      isActive: () => true,
      onOverflow: vi.fn(),
      memoryBudget: budget
    })
    second.socketClosed()
    expect(budget.evidence().bufferedSourceCount).toBe(0)
  })
})
