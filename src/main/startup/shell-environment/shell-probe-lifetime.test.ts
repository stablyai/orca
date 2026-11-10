import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const signalProcessTree = vi.hoisted(() => vi.fn(async () => true))

vi.mock('@orca/process-host/process-tree-termination', () => ({ signalProcessTree }))

import { bindShellProbeLifetime, SHELL_PROBE_TERMINATE_GRACE_MS } from './shell-probe-lifetime'

function fakeChild(): ChildProcess {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifetime only reads pid and calls kill(); the cast supplies exactly those members.
  return { pid: 4242, kill: vi.fn() } as unknown as ChildProcess
}

const realPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

describe('shell probe lifetime', () => {
  afterEach(() => {
    setPlatform(realPlatform)
    vi.useRealTimers()
    signalProcessTree.mockClear()
  })

  it('lets an interactive rc exit before force-killing a timed-out probe', async () => {
    setPlatform('linux')
    vi.useFakeTimers()
    const child = fakeChild()
    const lifetime = bindShellProbeLifetime(child)

    lifetime.terminate()
    expect(signalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(SHELL_PROBE_TERMINATE_GRACE_MS - 1)
    expect(signalProcessTree).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(signalProcessTree).toHaveBeenLastCalledWith(child, 'SIGKILL')

    lifetime.release()
  })

  it('force-kills a probe that outlives the grace even after its caller settles', async () => {
    setPlatform('linux')
    vi.useFakeTimers()
    const child = fakeChild()
    const lifetime = bindShellProbeLifetime(child)

    lifetime.terminate()
    // The caller settles and releases on the timeout; the probe ignores SIGTERM and stays alive.
    await vi.advanceTimersByTimeAsync(1)
    lifetime.release()
    expect(signalProcessTree).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SHELL_PROBE_TERMINATE_GRACE_MS)
    expect(signalProcessTree).toHaveBeenLastCalledWith(child, 'SIGKILL')
  })

  it('force-kills at once when the owner exits', () => {
    setPlatform('linux')
    const child = fakeChild()
    const lifetime = bindShellProbeLifetime(child)

    lifetime.kill()
    expect(signalProcessTree).toHaveBeenCalledWith(child, 'SIGKILL')

    lifetime.release()
  })

  it('force-kills immediately on Windows, where a probe has no group', () => {
    setPlatform('win32')
    const child = fakeChild()
    const lifetime = bindShellProbeLifetime(child)

    lifetime.terminate()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(signalProcessTree).not.toHaveBeenCalled()

    lifetime.release()
  })

  it('leaves no exit listener behind once the grace timer has fired', async () => {
    setPlatform('linux')
    vi.useFakeTimers()
    const before = process.listenerCount('exit')
    const lifetime = bindShellProbeLifetime(fakeChild())

    lifetime.terminate()
    // The caller settles and releases on the timeout, as both callers do.
    lifetime.release()
    await vi.advanceTimersByTimeAsync(SHELL_PROBE_TERMINATE_GRACE_MS)

    // The force timer owns the remaining registration; retaining it would pin the child.
    expect(process.listenerCount('exit')).toBe(before)
  })
})
