import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import {
  reportWorkerTerminalUserInput,
  resetWorkerTerminalTakeoverReportsForTest
} from './worker-terminal-takeover-report'

const success = { id: 'report', ok: true as const, result: { changed: 1 } }
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  resetWorkerTerminalTakeoverReportsForTest()
})
afterEach(() => vi.useRealTimers())

it('gates per handle and owning client for 30 seconds', () => {
  const relay = { sendRequest: vi.fn().mockResolvedValue(success) }
  const direct = { sendRequest: vi.fn().mockResolvedValue(success) }
  for (let i = 0; i < 100; i++) {
    reportWorkerTerminalUserInput(relay, 'term-1')
  }
  expect(relay.sendRequest).toHaveBeenCalledTimes(1)
  reportWorkerTerminalUserInput(relay, 'term-2')
  reportWorkerTerminalUserInput(direct, 'term-1')
  expect(relay.sendRequest).toHaveBeenCalledTimes(2)
  expect(direct.sendRequest).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(29_999)
  reportWorkerTerminalUserInput(relay, 'term-1')
  expect(relay.sendRequest).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(1)
  reportWorkerTerminalUserInput(relay, 'term-1')
  expect(relay.sendRequest).toHaveBeenCalledTimes(3)
  expect(relay.sendRequest).toHaveBeenLastCalledWith(
    'orchestration.workerTerminalUserInput',
    { terminal: 'term-1' },
    { timeoutMs: 5_000, budgetSpansConnect: true, failWhenDisconnected: true }
  )
})

it('does not await a report and coalesces input while it is pending', () => {
  const client = { sendRequest: vi.fn(() => new Promise<never>(() => {})) }
  expect(reportWorkerTerminalUserInput(client, 'term-1')).toBeUndefined()
  reportWorkerTerminalUserInput(client, 'term-1')
  expect(client.sendRequest).toHaveBeenCalledTimes(1)
})

it.each(['throw', 'rpc refusal'])(
  'retries a %s once on the same target, then permits a later attempt',
  async (failure) => {
    const client = {
      sendRequest:
        failure === 'throw'
          ? vi.fn().mockRejectedValue(new Error('offline'))
          : vi.fn().mockResolvedValue({ id: 'report', ok: false, error: { message: 'refused' } })
    }
    reportWorkerTerminalUserInput(client, 'term-1')
    await vi.advanceTimersByTimeAsync(249)
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
    client.sendRequest.mockResolvedValue(success)
    reportWorkerTerminalUserInput(client, 'term-1')
    expect(client.sendRequest).toHaveBeenCalledTimes(3)
  }
)

it('a report that changed nothing still arms the gate, so plain terminals pay once per window', async () => {
  // Why: the host answers `changed: 0` for every ordinary terminal; reopening on that turned
  // every accepted key into an RPC and a host write transaction (round 6 measurement: 100 for 100).
  const client = {
    sendRequest: vi.fn().mockResolvedValue({ id: 'report', ok: true, result: { changed: 0 } })
  }
  for (let i = 0; i < 100; i++) {
    reportWorkerTerminalUserInput(client, 'term-plain')
    await vi.advanceTimersByTimeAsync(100)
  }
  expect(client.sendRequest).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(30_000)
  reportWorkerTerminalUserInput(client, 'term-plain')
  expect(client.sendRequest).toHaveBeenCalledTimes(2)
})
