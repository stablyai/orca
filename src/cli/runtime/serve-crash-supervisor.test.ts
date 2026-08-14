import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  SERVE_ALREADY_RUNNING_EXIT_CODE,
  SERVE_SUPERVISED_SHUTDOWN_GRACE_MS
} from '../../shared/serve-supervision'
import {
  LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS,
  SERVE_REPLACEMENT_READY_TIMEOUT_MS
} from '../../shared/startup-readiness-deadlines'
import { waitForForegroundServeChild } from './serve-child-monitor'
import {
  SERVE_SUPERVISOR_STOP_EXIT_CODE,
  superviseForegroundServe
} from './serve-update-supervisor'

class FakeChildProcess extends EventEmitter {
  kill = vi.fn()
  pid: number

  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

const readyMessage = {
  type: 'orca:serve-ready',
  version: '1.4.181',
  runtimeId: 'runtime-ready',
  health: { websocket: 'ready', runtime: 'ready', graph: 'ready' }
}

type SupervisorArgs = Parameters<typeof superviseForegroundServe>[0]
type SupervisorOverrides = Partial<Omit<SupervisorArgs, 'child' | 'expectedHandoff' | 'spawnChild'>>
type TestSupervisorArgs = SupervisorArgs & { spawnChildMock: ReturnType<typeof vi.fn> }

function supervisorArgs(
  child: FakeChildProcess,
  overrides: SupervisorOverrides = {}
): TestSupervisorArgs {
  const spawnChildMock = vi.fn()
  return {
    executable: '/opt/orca/orca',
    childArgs: ['--serve'],
    spawnOptions: {},
    spawnChild: spawnChildMock as SupervisorArgs['spawnChild'],
    handoffPath: null,
    expectedHandoff: null,
    child: child as never,
    healthProbe: vi.fn(async () => ({ healthy: true as const, runtimeId: 'runtime-ready' })),
    recoverSingleton: vi.fn(async () => ({
      state: 'not-recoverable' as const,
      reason: 'missing_lock' as const
    })),
    sleep: vi.fn(async () => undefined),
    restartDelaysMs: [10, 20],
    healthCheckIntervalMs: 60_000,
    ...overrides,
    spawnChildMock
  }
}

describe('foreground serve crash supervisor', () => {
  it('outlives the child daemon-preservation fail-open before requiring readiness', async () => {
    vi.useFakeTimers()
    const child = new FakeChildProcess(4101)
    const healthProbe = vi.fn(async () => ({
      healthy: true as const,
      runtimeId: 'runtime-ready'
    }))
    try {
      const result = waitForForegroundServeChild(child as never, null, {
        healthProbe,
        healthCheckIntervalMs: 60_000,
        healthProbeTimeoutMs: 5_000,
        healthFailureLimit: 3
      })

      expect(
        SERVE_REPLACEMENT_READY_TIMEOUT_MS - LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS
      ).toBeGreaterThanOrEqual(30_000)
      await vi.advanceTimersByTimeAsync(LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS + 1)
      expect(child.kill).not.toHaveBeenCalled()

      child.emit('message', readyMessage)
      await vi.advanceTimersByTimeAsync(0)
      expect(healthProbe).toHaveBeenCalledOnce()
      expect(child.kill).not.toHaveBeenCalled()

      child.emit('exit', SERVE_SUPERVISOR_STOP_EXIT_CODE, null)
      await expect(result).resolves.toMatchObject({ readiness: 'verified' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves the main-process teardown budget before forcing exit', async () => {
    vi.useFakeTimers()
    const child = new FakeChildProcess(4101)
    const healthProbe = vi
      .fn()
      .mockResolvedValueOnce({ healthy: true, runtimeId: 'runtime-ready' })
      .mockResolvedValue({ healthy: false, reason: 'runtime_unreachable' })
    try {
      const result = waitForForegroundServeChild(child as never, null, {
        healthProbe,
        healthCheckIntervalMs: 1,
        healthProbeTimeoutMs: 1_000,
        healthFailureLimit: 1
      })
      child.emit('message', readyMessage)
      await vi.advanceTimersByTimeAsync(1)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')

      await vi.advanceTimersByTimeAsync(SERVE_SUPERVISED_SHUTDOWN_GRACE_MS - 1)
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
      await vi.advanceTimersByTimeAsync(1)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')

      child.emit('exit', 0, null)
      await result
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts a crashed main process after SIGSEGV', async () => {
    const first = new FakeChildProcess(4101)
    const replacement = new FakeChildProcess(4102)
    const args = supervisorArgs(first)
    args.spawnChildMock.mockReturnValue(replacement as never)

    const result = superviseForegroundServe(args)
    first.emit('message', readyMessage)
    await vi.waitFor(() => expect(args.healthProbe).toHaveBeenCalled())
    first.emit('exit', null, 'SIGSEGV')
    await vi.waitFor(() => expect(args.spawnChildMock).toHaveBeenCalledOnce())
    replacement.emit('message', readyMessage)
    await vi.waitFor(() => expect(args.healthProbe).toHaveBeenCalledTimes(2))
    replacement.emit('exit', SERVE_SUPERVISOR_STOP_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
  })

  it('keeps a reachable main alive while its promoted desktop is windowless', async () => {
    const child = new FakeChildProcess(4101)
    const healthProbe = vi
      .fn()
      .mockResolvedValueOnce({ healthy: true, runtimeId: 'runtime-ready' })
      .mockResolvedValue({ healthy: false, reason: 'graph_not_ready' })
    const args = supervisorArgs(child, {
      healthProbe,
      healthCheckIntervalMs: 1,
      healthFailureLimit: 3
    })

    const result = superviseForegroundServe(args)
    child.emit('message', readyMessage)
    await vi.waitFor(() => expect(healthProbe.mock.calls.length).toBeGreaterThanOrEqual(4))
    expect(child.kill).not.toHaveBeenCalled()
    expect(args.spawnChildMock).not.toHaveBeenCalled()
    child.emit('exit', SERVE_SUPERVISOR_STOP_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
  })

  it('counts a hung runtime health probe as a failed check', async () => {
    const first = new FakeChildProcess(4101)
    const replacement = new FakeChildProcess(4102)
    const healthProbe = vi
      .fn()
      .mockResolvedValueOnce({ healthy: true, runtimeId: 'runtime-ready' })
      .mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockResolvedValue({ healthy: true, runtimeId: 'runtime-ready' })
    const args = supervisorArgs(first, {
      healthProbe,
      healthCheckIntervalMs: 1,
      healthProbeTimeoutMs: 5,
      healthFailureLimit: 1
    })
    args.spawnChildMock.mockReturnValue(replacement as never)

    const result = superviseForegroundServe(args)
    first.emit('message', readyMessage)
    await vi.waitFor(() => expect(first.kill).toHaveBeenCalledWith('SIGTERM'))
    first.emit('exit', 0, null)
    await vi.waitFor(() => expect(args.spawnChildMock).toHaveBeenCalledOnce())
    replacement.emit('message', readyMessage)
    await vi.waitFor(() => expect(healthProbe).toHaveBeenCalledTimes(3))
    replacement.emit('exit', SERVE_SUPERVISOR_STOP_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
  })

  it('uses bounded backoff and returns a stable non-retryable code when exhausted', async () => {
    const first = new FakeChildProcess(4101)
    const second = new FakeChildProcess(4102)
    const third = new FakeChildProcess(4103)
    const args = supervisorArgs(first)
    args.spawnChildMock.mockReturnValueOnce(second as never).mockReturnValueOnce(third as never)

    const result = superviseForegroundServe(args)
    first.emit('exit', 1, null)
    await vi.waitFor(() => expect(args.spawnChildMock).toHaveBeenCalledTimes(1))
    second.emit('exit', 1, null)
    await vi.waitFor(() => expect(args.spawnChildMock).toHaveBeenCalledTimes(2))
    third.emit('exit', 1, null)

    await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
    expect(args.sleep).toHaveBeenNthCalledWith(1, 10)
    expect(args.sleep).toHaveBeenNthCalledWith(2, 20)
  })

  it('does not retry a child that reports the supervisor stop code', async () => {
    const child = new FakeChildProcess(4101)
    const args = supervisorArgs(child)

    const result = superviseForegroundServe(args)
    child.emit('exit', SERVE_SUPERVISOR_STOP_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
    expect(args.spawnChildMock).not.toHaveBeenCalled()
    expect(args.sleep).not.toHaveBeenCalled()
  })

  it('restarts a healthy main process that exits unexpectedly with code zero', async () => {
    const first = new FakeChildProcess(4101)
    const replacement = new FakeChildProcess(4102)
    const args = supervisorArgs(first)
    args.spawnChildMock.mockReturnValue(replacement as never)

    const result = superviseForegroundServe(args)
    first.emit('message', readyMessage)
    await vi.waitFor(() => expect(args.healthProbe).toHaveBeenCalledOnce())
    first.emit('exit', 0, null)
    await vi.waitFor(() => expect(args.spawnChildMock).toHaveBeenCalledOnce())
    replacement.emit('exit', SERVE_SUPERVISOR_STOP_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
  })

  it('applies the same restart budget when spawning the main process fails', async () => {
    const first = new FakeChildProcess(4101)
    const replacement = new FakeChildProcess(4102)
    const args = supervisorArgs(first, { restartDelaysMs: [10] })
    args.spawnChildMock.mockReturnValue(replacement as never)

    const result = superviseForegroundServe(args)
    first.emit('error', new Error('spawn EAGAIN'))
    await vi.waitFor(() => expect(args.spawnChildMock).toHaveBeenCalledOnce())
    replacement.emit('error', new Error('spawn EAGAIN'))

    await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
    expect(args.sleep).toHaveBeenCalledOnce()
  })

  it('stops recovery when the temporary filesystem becomes full', async () => {
    const child = new FakeChildProcess(4101)
    const beforeRestart = vi.fn(async () => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    })
    const args = supervisorArgs(child, { beforeRestart })

    const result = superviseForegroundServe(args)
    child.emit('exit', 1, null)

    await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
    expect(beforeRestart).toHaveBeenCalledOnce()
    expect(args.spawnChildMock).not.toHaveBeenCalled()
  })

  it('isolates a stale singleton and retries lock acquisition only once', async () => {
    const first = new FakeChildProcess(4101)
    const retry = new FakeChildProcess(4102)
    const recoverSingleton = vi.fn(async () => ({
      state: 'recovered' as const,
      ownerPid: 4000,
      quarantined: ['SingletonLock.test']
    }))
    const args = supervisorArgs(first, { recoverSingleton })
    args.spawnChildMock.mockReturnValue(retry as never)

    const result = superviseForegroundServe(args)
    first.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)
    await vi.waitFor(() => expect(args.spawnChildMock).toHaveBeenCalledOnce())
    retry.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_ALREADY_RUNNING_EXIT_CODE)
    expect(recoverSingleton).toHaveBeenCalledOnce()
    expect(args.spawnChildMock).toHaveBeenCalledOnce()
  })

  it('cleans exact quarantine before a concurrent winner reports ready', async () => {
    const collision = new FakeChildProcess(4101)
    const retry = new FakeChildProcess(4102)
    const cleanupSingletonQuarantine = vi.fn(async () => undefined)
    const args = supervisorArgs(collision, {
      healthProbe: vi.fn(async () => ({
        healthy: false as const,
        reason: 'metadata_missing' as const
      })),
      recoverSingleton: vi.fn(async () => ({
        state: 'recovered' as const,
        ownerPid: 4000,
        quarantined: ['SingletonLock.test']
      })),
      cleanupSingletonQuarantine
    })
    args.spawnChildMock.mockReturnValue(retry as never)

    const result = superviseForegroundServe(args)
    collision.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)
    await vi.waitFor(() => expect(args.spawnChildMock).toHaveBeenCalledOnce())
    retry.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_ALREADY_RUNNING_EXIT_CODE)
    expect(cleanupSingletonQuarantine).toHaveBeenCalledWith(['SingletonLock.test'])
  })

  it('allows one stale-lock retry again after a recovered child becomes healthy', async () => {
    const collisionOne = new FakeChildProcess(4101)
    const healthyOne = new FakeChildProcess(4102)
    const collisionTwo = new FakeChildProcess(4103)
    const healthyTwo = new FakeChildProcess(4104)
    const recoverSingleton = vi.fn(async () => ({
      state: 'recovered' as const,
      ownerPid: 4000,
      quarantined: ['SingletonLock.test']
    }))
    const cleanupSingletonQuarantine = vi.fn(async () => undefined)
    const args = supervisorArgs(collisionOne, {
      recoverSingleton,
      cleanupSingletonQuarantine
    })
    args.spawnChildMock
      .mockReturnValueOnce(healthyOne as never)
      .mockReturnValueOnce(collisionTwo as never)
      .mockReturnValueOnce(healthyTwo as never)

    const result = superviseForegroundServe(args)
    collisionOne.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)
    await vi.waitFor(() => expect(args.spawnChildMock).toHaveBeenCalledTimes(1))
    healthyOne.emit('message', readyMessage)
    await vi.waitFor(() => expect(args.healthProbe).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(cleanupSingletonQuarantine).toHaveBeenNthCalledWith(1, ['SingletonLock.test'])
    )
    healthyOne.emit('exit', 1, null)
    await vi.waitFor(() => expect(args.spawnChildMock).toHaveBeenCalledTimes(2))
    collisionTwo.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)
    await vi.waitFor(() => expect(args.spawnChildMock).toHaveBeenCalledTimes(3))
    healthyTwo.emit('message', readyMessage)
    await vi.waitFor(() => expect(args.healthProbe).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(cleanupSingletonQuarantine).toHaveBeenNthCalledWith(2, ['SingletonLock.test'])
    )
    healthyTwo.emit('exit', SERVE_SUPERVISOR_STOP_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
    expect(recoverSingleton).toHaveBeenCalledTimes(2)
  })

  it('does not retry or isolate when a healthy owner holds the lock', async () => {
    const child = new FakeChildProcess(4101)
    const recoverSingleton = vi.fn(async () => ({
      state: 'active-owner' as const,
      runtimeId: 'runtime-live'
    }))
    const args = supervisorArgs(child, { recoverSingleton })

    const result = superviseForegroundServe(args)
    child.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_ALREADY_RUNNING_EXIT_CODE)
    expect(args.spawnChildMock).not.toHaveBeenCalled()
    expect(recoverSingleton).toHaveBeenCalledOnce()
  })
})
