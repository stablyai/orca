import { afterEach, expect, it, vi } from 'vitest'
import {
  OPENCODE_SQLITE_SCAN_BUDGET_MS,
  runOpenCodeSqliteScanRequest,
  withOpenCodeSqliteScanScope
} from './session-scanner-opencode-sqlite-scan-scope'

afterEach(() => vi.useRealTimers())

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) {
    throw new Error('Missing scoped request signal')
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

it('spends the budget while admission is pending and refuses later work in that scan', async () => {
  vi.useFakeTimers()
  const admitted = vi.fn()
  const outcome = withOpenCodeSqliteScanScope(async () => {
    const error = await runOpenCodeSqliteScanRequest(undefined, waitForAbort).catch((err) => err)
    expect(error).toMatchObject({ name: 'OpenCodeSqliteScanDeadlineError' })
    await expect(runOpenCodeSqliteScanRequest(undefined, admitted)).rejects.toBe(error)
  })
  await vi.advanceTimersByTimeAsync(OPENCODE_SQLITE_SCAN_BUDGET_MS)
  await outcome
  expect(admitted).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('banks only outstanding work across legs and does not spend other-agent time', async () => {
  vi.useFakeTimers()
  const outcome = withOpenCodeSqliteScanScope(async () => {
    await runOpenCodeSqliteScanRequest(undefined, () => wait(20_000))
    await wait(70_000)
    return runOpenCodeSqliteScanRequest(undefined, waitForAbort)
  }).catch((error) => error)
  await vi.advanceTimersByTimeAsync(90_000)
  let completed = false
  void outcome.then(() => {
    completed = true
  })
  await vi.advanceTimersByTimeAsync(24_999)
  expect(completed).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await outcome).toMatchObject({ name: 'OpenCodeSqliteScanDeadlineError' })
  expect(vi.getTimerCount()).toBe(0)
})

it('counts overlapping preparation and worker waits once', async () => {
  vi.useFakeTimers()
  const outcome = withOpenCodeSqliteScanScope(() =>
    runOpenCodeSqliteScanRequest(undefined, () =>
      Promise.all([
        runOpenCodeSqliteScanRequest(undefined, waitForAbort),
        runOpenCodeSqliteScanRequest(undefined, waitForAbort)
      ])
    )
  ).catch((error) => error)
  await vi.advanceTimersByTimeAsync(OPENCODE_SQLITE_SCAN_BUDGET_MS - 1)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(await outcome).toMatchObject({ name: 'OpenCodeSqliteScanDeadlineError' })
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps concurrent scans independent and gives the next scan a fresh owner and budget', async () => {
  vi.useFakeTimers()
  const owners: unknown[] = []
  const first = withOpenCodeSqliteScanScope(() =>
    runOpenCodeSqliteScanRequest(undefined, (signal, owner) => {
      owners.push(owner)
      return waitForAbort(signal)
    })
  ).catch((error) => error)
  await vi.advanceTimersByTimeAsync(30_000)
  const second = withOpenCodeSqliteScanScope(() =>
    runOpenCodeSqliteScanRequest(undefined, (signal, owner) => {
      owners.push(owner)
      return waitForAbort(signal)
    })
  ).catch((error) => error)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(await first).toMatchObject({ name: 'OpenCodeSqliteScanDeadlineError' })
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await second).toMatchObject({ name: 'OpenCodeSqliteScanDeadlineError' })
  await withOpenCodeSqliteScanScope(() =>
    runOpenCodeSqliteScanRequest(undefined, async (_signal, owner) => {
      owners.push(owner)
    })
  )
  expect(new Set(owners).size).toBe(3)
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves the caller cancellation reason and disposes its timer', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const reason = new Error('caller cancelled')
  const outcome = withOpenCodeSqliteScanScope(() =>
    runOpenCodeSqliteScanRequest(controller.signal, waitForAbort)
  ).catch((error) => error)
  controller.abort(reason)
  expect(await outcome).toBe(reason)
  expect(vi.getTimerCount()).toBe(0)
})

it('leaves unrelated native-chat and Zcode calls unscoped and retires the scan signal', async () => {
  vi.useFakeTimers()
  let scopedSignal: AbortSignal | undefined
  const caller = new AbortController()
  await withOpenCodeSqliteScanScope(async () => {
    for (const agent of ['zcode', 'native-chat'] as const) {
      await runOpenCodeSqliteScanRequest(
        caller.signal,
        async (signal, owner) => {
          expect(signal).toBe(caller.signal)
          expect(owner).toBeUndefined()
          expect(vi.getTimerCount()).toBe(0)
        },
        agent
      )
    }
    await runOpenCodeSqliteScanRequest(undefined, async (signal) => {
      scopedSignal = signal
    })
  })
  expect(scopedSignal?.aborted).toBe(true)
  expect(caller.signal.aborted).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
