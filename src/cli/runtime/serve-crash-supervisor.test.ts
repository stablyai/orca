import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
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

function supervisorArgs(child: FakeChildProcess, overrides: Record<string, unknown> = {}) {
  return {
    executable: '/opt/orca/orca',
    childArgs: ['--serve'],
    spawnOptions: {},
    spawnChild: vi.fn(),
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
    ...overrides
  }
}

describe('foreground serve crash supervisor', () => {
  it('restarts a crashed main process after SIGSEGV', async () => {
    const first = new FakeChildProcess(4101)
    const replacement = new FakeChildProcess(4102)
    const args = supervisorArgs(first)
    args.spawnChild.mockReturnValue(replacement as never)

    const result = superviseForegroundServe(args)
    first.emit('message', readyMessage)
    await vi.waitFor(() => expect(args.healthProbe).toHaveBeenCalled())
    first.emit('exit', null, 'SIGSEGV')
    await vi.waitFor(() => expect(args.spawnChild).toHaveBeenCalledOnce())
    replacement.emit('message', readyMessage)
    await vi.waitFor(() => expect(args.healthProbe).toHaveBeenCalledTimes(2))
    replacement.emit('exit', SERVE_SUPERVISOR_STOP_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
  })

  it('restarts after renderer graph health is lost without touching daemon sessions', async () => {
    const first = new FakeChildProcess(4101)
    const replacement = new FakeChildProcess(4102)
    const healthProbe = vi
      .fn()
      .mockResolvedValueOnce({ healthy: true, runtimeId: 'runtime-ready' })
      .mockResolvedValueOnce({ healthy: false, reason: 'graph_not_ready' })
      .mockResolvedValue({ healthy: true, runtimeId: 'runtime-ready' })
    const args = supervisorArgs(first, {
      healthProbe,
      healthCheckIntervalMs: 1,
      healthFailureLimit: 1
    })
    args.spawnChild.mockReturnValue(replacement as never)

    const result = superviseForegroundServe(args)
    first.emit('message', readyMessage)
    await vi.waitFor(() => expect(first.kill).toHaveBeenCalledWith('SIGTERM'))
    first.emit('exit', 0, null)
    await vi.waitFor(() => expect(args.spawnChild).toHaveBeenCalledOnce())
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
    args.spawnChild.mockReturnValueOnce(second as never).mockReturnValueOnce(third as never)

    const result = superviseForegroundServe(args)
    first.emit('exit', 1, null)
    await vi.waitFor(() => expect(args.spawnChild).toHaveBeenCalledTimes(1))
    second.emit('exit', 1, null)
    await vi.waitFor(() => expect(args.spawnChild).toHaveBeenCalledTimes(2))
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
    expect(args.spawnChild).not.toHaveBeenCalled()
    expect(args.sleep).not.toHaveBeenCalled()
  })

  it('restarts a healthy main process that exits unexpectedly with code zero', async () => {
    const first = new FakeChildProcess(4101)
    const replacement = new FakeChildProcess(4102)
    const args = supervisorArgs(first)
    args.spawnChild.mockReturnValue(replacement as never)

    const result = superviseForegroundServe(args)
    first.emit('message', readyMessage)
    await vi.waitFor(() => expect(args.healthProbe).toHaveBeenCalledOnce())
    first.emit('exit', 0, null)
    await vi.waitFor(() => expect(args.spawnChild).toHaveBeenCalledOnce())
    replacement.emit('exit', SERVE_SUPERVISOR_STOP_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
  })

  it('applies the same restart budget when spawning the main process fails', async () => {
    const first = new FakeChildProcess(4101)
    const replacement = new FakeChildProcess(4102)
    const args = supervisorArgs(first, { restartDelaysMs: [10] })
    args.spawnChild.mockReturnValue(replacement as never)

    const result = superviseForegroundServe(args)
    first.emit('error', new Error('spawn EAGAIN'))
    await vi.waitFor(() => expect(args.spawnChild).toHaveBeenCalledOnce())
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
    expect(args.spawnChild).not.toHaveBeenCalled()
  })

  it('isolates a stale singleton and retries lock acquisition only once', async () => {
    const first = new FakeChildProcess(4101)
    const retry = new FakeChildProcess(4102)
    const recoverSingleton = vi.fn(async () => ({ state: 'recovered' as const, ownerPid: 4000 }))
    const args = supervisorArgs(first, { recoverSingleton })
    args.spawnChild.mockReturnValue(retry as never)

    const result = superviseForegroundServe(args)
    first.emit('exit', 3, null)
    await vi.waitFor(() => expect(args.spawnChild).toHaveBeenCalledOnce())
    retry.emit('exit', 3, null)

    await expect(result).resolves.toBe(3)
    expect(recoverSingleton).toHaveBeenCalledOnce()
    expect(args.spawnChild).toHaveBeenCalledOnce()
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
    const args = supervisorArgs(collisionOne, { recoverSingleton })
    args.spawnChild
      .mockReturnValueOnce(healthyOne as never)
      .mockReturnValueOnce(collisionTwo as never)
      .mockReturnValueOnce(healthyTwo as never)

    const result = superviseForegroundServe(args)
    collisionOne.emit('exit', 3, null)
    await vi.waitFor(() => expect(args.spawnChild).toHaveBeenCalledTimes(1))
    healthyOne.emit('message', readyMessage)
    await vi.waitFor(() => expect(args.healthProbe).toHaveBeenCalledOnce())
    healthyOne.emit('exit', 1, null)
    await vi.waitFor(() => expect(args.spawnChild).toHaveBeenCalledTimes(2))
    collisionTwo.emit('exit', 3, null)
    await vi.waitFor(() => expect(args.spawnChild).toHaveBeenCalledTimes(3))
    healthyTwo.emit('message', readyMessage)
    await vi.waitFor(() => expect(args.healthProbe).toHaveBeenCalledTimes(2))
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
    child.emit('exit', 3, null)

    await expect(result).resolves.toBe(3)
    expect(args.spawnChild).not.toHaveBeenCalled()
    expect(recoverSingleton).toHaveBeenCalledOnce()
  })
})
