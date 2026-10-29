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

it('gates per owning client and sends the handle-addressed report', () => {
  const relay = { sendRequest: vi.fn().mockResolvedValue(success) }
  const direct = { sendRequest: vi.fn().mockResolvedValue(success) }
  reportWorkerTerminalUserInput(relay, 'term-1')
  reportWorkerTerminalUserInput(relay, 'term-1')
  reportWorkerTerminalUserInput(direct, 'term-1')
  expect(relay.sendRequest).toHaveBeenCalledTimes(1)
  expect(direct.sendRequest).toHaveBeenCalledTimes(1)
  expect(relay.sendRequest).toHaveBeenLastCalledWith(
    'orchestration.workerTerminalUserInput',
    { terminal: 'term-1' },
    { timeoutMs: 5_000, budgetSpansConnect: true, failWhenDisconnected: true }
  )
})

it('treats an rpc refusal as a failed report and retries it once', async () => {
  const client = {
    sendRequest: vi.fn().mockResolvedValue({
      id: 'report',
      ok: false,
      error: { code: 'permission_denied', message: 'refused' }
    })
  }
  reportWorkerTerminalUserInput(client, 'term-1')
  await vi.advanceTimersByTimeAsync(250)
  expect(client.sendRequest).toHaveBeenCalledTimes(2)
  client.sendRequest.mockResolvedValue(success)
  reportWorkerTerminalUserInput(client, 'term-1')
  expect(client.sendRequest).toHaveBeenCalledTimes(3)
})

it('a report that changed nothing still arms the gate, so plain terminals pay once per window', async () => {
  // Ordinary terminals answer changed: 0; reopening on that would issue one RPC and host write per key.
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
