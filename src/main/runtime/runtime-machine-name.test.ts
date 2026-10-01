import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeMachineName } from '../../shared/machine-name'
import { detectRuntimeMachineName, type RuntimeMachineName } from './runtime-machine-name'

// Why mocked: the shared lookup is the one path that spawns the real `scutil`; a live spawn on a
// loaded macOS runner can hit the lookup timeout and answer with the hostname while a second live
// spawn does not, which is a flake and not a verdict.
const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

const friendlyResult = {
  code: 0,
  signal: null,
  stdout: 'Friendly Name\n',
  stderr: '',
  timedOut: false
}
const timedOutResult = { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }

describe('runtime machine name detection', () => {
  it('uses the hostname on non-macOS without starting a subprocess', async () => {
    const run = vi.fn()
    await expect(
      detectRuntimeMachineName({ platform: 'linux', fallback: 'linux-host', run })
    ).resolves.toEqual({ name: 'linux-host', final: true })
    expect(run).not.toHaveBeenCalled()
  })

  it('uses the macOS friendly computer name when scutil succeeds', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'M4 Air\n',
      stderr: '',
      timedOut: false
    })
    await expect(
      detectRuntimeMachineName({ platform: 'darwin', fallback: 'm4-air.local', run })
    ).resolves.toEqual({ name: 'M4 Air', final: true })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/usr/sbin/scutil', args: ['--get', 'ComputerName'] })
    )
  })

  it('falls back without finality when macOS name lookup fails or returns no name', async () => {
    for (const run of [
      vi.fn().mockResolvedValue({
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'could not read',
        timedOut: false
      }),
      vi.fn().mockResolvedValue(timedOutResult),
      vi
        .fn()
        .mockResolvedValue({ code: 0, signal: null, stdout: '  \n', stderr: '', timedOut: false }),
      vi.fn().mockRejectedValue(new Error('spawn failed'))
    ]) {
      await expect(
        detectRuntimeMachineName({ platform: 'darwin', fallback: 'm4-air.local', run })
      ).resolves.toEqual({ name: 'm4-air.local', final: false })
    }
  })
})

describe('RuntimeMachineName', () => {
  // Why reloaded: the lookup memo is module state shared by every runtime in the process, which
  // is the behaviour under test, so each case starts from a process that has never looked.
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

  it('prefers a configured name and falls back to the detected name', async () => {
    let configured: string | undefined
    const machine = new module.RuntimeMachineName(() => configured)
    expect(machine.read()).toBeTypeOf('string')
    configured = '  Build server  '
    expect(machine.read()).toBe('Build server')
  })
})
