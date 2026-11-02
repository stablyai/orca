import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeMachineName } from '../../shared/machine-name'
import type { RuntimeMachineName } from './runtime-machine-name'

// Mock shared scutil lookup: runner load can make one live probe time out while another succeeds, yielding a flaky comparison.
const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

const friendlyResult = {
  code: 0,
  signal: null,
  stdout: 'Friendly Name\n',
  stderr: '',
  timedOut: false
}
const timedOutResult = { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }

describe('RuntimeMachineName', () => {
  // Reload process-shared memo so every case begins before the first lookup.
  let module: {
    RuntimeMachineName: typeof RuntimeMachineName
    MACHINE_NAME_RETRY_INTERVAL_MS: number
  }
  const hostname = normalizeMachineName(os.hostname())

  beforeEach(async () => {
    vi.resetModules()
    runProcessMock.mockReset()
    module = await import('./runtime-machine-name')
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.useRealTimers()
  })

  function onDarwin(): void {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  }

  it('answers with the hostname until the one shared lookup lands', async () => {
    let finishLookup: ((value: unknown) => void) | undefined
    runProcessMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve
        })
    )
    const first = new module.RuntimeMachineName(() => undefined)
    const second = new module.RuntimeMachineName(() => undefined)
    first.start()
    second.start()
    first.start()

    expect(first.read()).toBe(hostname)
    expect(second.read()).toBe(hostname)
    if (process.platform !== 'darwin') {
      expect(runProcessMock).not.toHaveBeenCalled()
      await first.ready()
      expect(first.read()).toBe(hostname)
      return
    }
    // Every runtime in the process shares one lookup; the second `start` must not spawn again.
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    finishLookup?.(friendlyResult)
    // `ready` is the publisher's gate: once it settles, no reader sees the hostname again.
    await first.ready()
    expect(first.read()).toBe('Friendly Name')
    await second.ready()
    expect(second.read()).toBe('Friendly Name')
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('retries a timed-out lookup after the retry interval instead of latching the hostname', async () => {
    onDarwin()
    vi.useFakeTimers()
    runProcessMock.mockResolvedValueOnce(timedOutResult).mockResolvedValueOnce(friendlyResult)
    const machine = new module.RuntimeMachineName(() => undefined)

    await machine.ready()
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(machine.read()).toBe(hostname)

    vi.advanceTimersByTime(module.MACHINE_NAME_RETRY_INTERVAL_MS)
    await machine.ready()
    expect(runProcessMock).toHaveBeenCalledTimes(2)
    expect(machine.read()).toBe('Friendly Name')
  })

  it('bounds spawn churn: ready() calls inside the retry interval spawn once after a failure', async () => {
    onDarwin()
    vi.useFakeTimers()
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'could not read',
      timedOut: false
    })
    const machine = new module.RuntimeMachineName(() => undefined)

    await machine.ready()
    vi.advanceTimersByTime(module.MACHINE_NAME_RETRY_INTERVAL_MS - 1)
    await machine.ready()
    await new module.RuntimeMachineName(() => undefined).ready()
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(machine.read()).toBe(hostname)

    vi.advanceTimersByTime(1)
    await machine.ready()
    expect(runProcessMock).toHaveBeenCalledTimes(2)
  })

  it('treats a successful lookup as final: later ready() calls never spawn again', async () => {
    onDarwin()
    vi.useFakeTimers()
    runProcessMock.mockResolvedValue(friendlyResult)
    const machine = new module.RuntimeMachineName(() => undefined)

    await machine.ready()
    vi.advanceTimersByTime(module.MACHINE_NAME_RETRY_INTERVAL_MS * 10)
    await machine.ready()
    await new module.RuntimeMachineName(() => undefined).ready()
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(machine.read()).toBe('Friendly Name')
  })

  it('readyWithin stops waiting at the budget and later settles with the lookup', async () => {
    onDarwin()
    vi.useFakeTimers()
    let finishLookup: ((value: unknown) => void) | undefined
    runProcessMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve
        })
    )
    const machine = new module.RuntimeMachineName(() => undefined)

    let budgetElapsed = false
    const withinBudget = machine.readyWithin(750).then(() => {
      budgetElapsed = true
    })
    await vi.advanceTimersByTimeAsync(749)
    expect(budgetElapsed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await withinBudget
    expect(machine.read()).toBe(hostname)

    finishLookup?.(friendlyResult)
    await machine.readyWithin(750)
    expect(machine.read()).toBe('Friendly Name')
    expect(vi.getTimerCount()).toBe(0)
  })
})
