import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionTerminationController } from './session-termination-controller'
import type { SubprocessHandle } from './session-subprocess-handle'

function createController(options: { signalProcessGroups?: false } = {}) {
  let exited = false
  const signalProcessGroups = vi.fn<(signal: NodeJS.Signals) => void>()
  const forceKill = vi.fn()
  const releaseProducerPause = vi.fn()
  const subprocess = {
    pid: 10,
    getForegroundProcess: () => null,
    write: () => {},
    resize: () => {},
    kill: () => {},
    forceKill,
    terminateOwnedTree: () => 'unavailable' as const,
    signal: () => {},
    onData: () => {},
    onExit: () => {},
    dispose: () => {},
    ...(options.signalProcessGroups === false ? {} : { signalProcessGroups })
  } as unknown as SubprocessHandle
  const controller = new SessionTerminationController({
    sessionId: 'pty-1',
    subprocess,
    launchAgent: 'claude',
    isExited: () => exited,
    releaseProducerPause
  })
  return {
    controller,
    signalProcessGroups,
    forceKill,
    releaseProducerPause,
    markExited() {
      exited = true
      controller.markPhysicalExit()
    }
  }
}

describe('signalGroupsThenForceKillWithinBudget', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('sends SIGTERM to the process groups before SIGKILL', async () => {
    vi.useFakeTimers()
    const harness = createController()
    const order: string[] = []
    harness.signalProcessGroups.mockImplementation((signal) => {
      order.push(signal)
    })
    harness.forceKill.mockImplementation(() => {
      order.push('SIGKILL')
      harness.markExited()
    })

    const pending = harness.controller.signalGroupsThenForceKillWithinBudget()
    expect(order).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1_999)
    expect(order).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(order).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('SIGKILLs leftover groups when the root exits during SIGTERM', async () => {
    const harness = createController()
    const signals: NodeJS.Signals[] = []
    harness.signalProcessGroups.mockImplementation((signal) => {
      signals.push(signal)
      if (signal === 'SIGTERM') {
        harness.markExited()
      }
    })

    await harness.controller.signalGroupsThenForceKillWithinBudget()

    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(harness.forceKill).not.toHaveBeenCalled()
  })

  it('SIGKILLs leftover groups when the root exits during the grace', async () => {
    vi.useFakeTimers()
    const harness = createController()
    const signals: NodeJS.Signals[] = []
    harness.signalProcessGroups.mockImplementation((signal) => {
      signals.push(signal)
    })

    const pending = harness.controller.signalGroupsThenForceKillWithinBudget()
    expect(signals).toEqual(['SIGTERM'])
    harness.markExited()
    await pending

    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(harness.forceKill).not.toHaveBeenCalled()
  })

  it('force-kills when the process is still alive after the grace', async () => {
    vi.useFakeTimers()
    const harness = createController()
    harness.forceKill.mockImplementation(() => {
      harness.markExited()
    })

    const pending = harness.controller.signalGroupsThenForceKillWithinBudget()
    expect(harness.forceKill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    await pending
    expect(harness.forceKill).toHaveBeenCalledTimes(1)
  })

  it('does not wait longer than the caller timeout', async () => {
    vi.useFakeTimers()
    const harness = createController()
    const startedAt = Date.now()
    const pending = harness.controller.signalGroupsThenForceKillWithinBudget(25)
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    )

    await vi.advanceTimersByTimeAsync(25)

    expect(harness.signalProcessGroups).toHaveBeenCalledWith('SIGTERM')
    expect(harness.forceKill).toHaveBeenCalledTimes(1)
    await expect(outcome).resolves.toBe('rejected')
    expect(Date.now() - startedAt).toBeLessThanOrEqual(25)
  })

  it('force-kills immediately when the subprocess cannot signal process groups', async () => {
    const harness = createController({ signalProcessGroups: false })
    harness.forceKill.mockImplementation(() => {
      harness.markExited()
    })

    await harness.controller.signalGroupsThenForceKillWithinBudget(50)

    expect(harness.signalProcessGroups).not.toHaveBeenCalled()
    expect(harness.forceKill).toHaveBeenCalledTimes(1)
  })

  it('force-kills a Windows session without waiting out the POSIX grace', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const harness = createController()
      harness.forceKill.mockImplementation(() => {
        harness.markExited()
      })

      await harness.controller.signalGroupsThenForceKillWithinBudget(8_000)

      expect(harness.signalProcessGroups).not.toHaveBeenCalled()
      expect(harness.forceKill).toHaveBeenCalledTimes(1)
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('does not spend the force-kill retry outside the caller timeout', async () => {
    vi.useFakeTimers()
    const harness = createController()
    harness.forceKill.mockImplementation(() => {
      throw new Error('kill failed')
    })

    const pending = harness.controller.signalGroupsThenForceKillWithinBudget(25)
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    )
    await vi.advanceTimersByTimeAsync(25)

    await expect(outcome).resolves.toBe('rejected')
    expect(harness.forceKill).toHaveBeenCalledTimes(1)
  })

  it('does not signal a process that has already exited', async () => {
    const harness = createController()
    harness.markExited()

    await harness.controller.signalGroupsThenForceKillWithinBudget()

    expect(harness.signalProcessGroups).not.toHaveBeenCalled()
    expect(harness.forceKill).not.toHaveBeenCalled()
  })
})
