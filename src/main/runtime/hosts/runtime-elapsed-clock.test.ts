import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let monotonic: bigint
let wall: number

beforeEach(() => {
  vi.resetModules()
  monotonic = 1_000_000_000_000n
  wall = 1_700_000_000_000
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => monotonic)
  vi.spyOn(Date, 'now').mockImplementation(() => wall)
})
afterEach(() => vi.restoreAllMocks())

async function subject(expiresAtMs = 65000) {
  const { readRuntimeElapsedClock } = await import('./runtime-elapsed-clock')
  const { terminalChatCallBudget, assertTerminalChatCallCurrent } =
    await import('../../ipc/runtime-environments/terminal-chat-call-deadline')
  readRuntimeElapsedClock()
  const budget = terminalChatCallBudget(
    {
      method: 'terminal.send',
      params: {
        chatPrompt: {
          agent: 'claude',
          text: 'owned input',
          expiry: { runtimeId: 'host', expiresAtMs }
        }
      }
    },
    'host'
  )
  return { readRuntimeElapsedClock, remaining: () => assertTerminalChatCallCurrent(budget) }
}

it('refuses an expired grant after Linux-shaped suspend before timeout callbacks run', async () => {
  const { remaining } = await subject()
  expect(remaining()).toBe(64999)
  monotonic += 10_000_000n
  wall += 10
  expect(remaining()).toBe(64989)
  wall += 120000
  expect(remaining).toThrow('Chat input request expired')
})

it('compares a published lower sample with the fresh upper check across fractional wall phases', async () => {
  const { readRuntimeElapsedClock, remaining } = await subject(6001)
  monotonic += 1_000_500_000n
  wall += 1000
  expect(readRuntimeElapsedClock()).toEqual({ lower: 1000, upper: 1001 })
  expect(remaining()).toBe(5000)
  // A 5000 ms wall delta can span up to just under 5001 ms across suspend.
  wall += 5000
  expect(remaining).toThrow('Chat input request expired')
})

it('keeps an outstanding grant advancing after a forward wall correction and rollback', async () => {
  const { remaining } = await subject()
  monotonic += 1_000_000n
  wall += 10000
  expect(remaining()).toBe(54999)
  monotonic += 10_000_000n
  wall -= 10000
  expect(remaining()).toBe(54989)
  monotonic += 10_000_000n
  wall += 10
  expect(remaining()).toBe(54979)
})

it('continues the same grant epoch after an invalid observation instead of reanchoring it', async () => {
  const { readRuntimeElapsedClock, remaining } = await subject()
  wall = Number.NaN
  monotonic += 100_000_000n
  expect(readRuntimeElapsedClock()).toBeNull()
  wall = 1_700_000_001_000
  monotonic += 900_000_000n
  expect(remaining()).toBe(63999)
})
