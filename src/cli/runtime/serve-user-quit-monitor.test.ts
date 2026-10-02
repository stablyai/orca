import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVE_SUPERVISED_SHUTDOWN_GRACE_MS } from '../../shared/serve-supervision'
import { getServeUpdateHandoffPath } from '../../shared/serve-update-handoff'
import { waitForForegroundServeChild } from './serve-child-monitor'
import type { ServeRuntimeHealth } from './serve-runtime-health'
import {
  SERVE_SUPERVISOR_STOP_EXIT_CODE,
  superviseForegroundServe
} from './serve-update-supervisor'

class Child extends EventEmitter {
  pid = 4101
  kill = vi.fn()
}

const ready = {
  type: 'orca:serve-ready',
  version: '1.4.181',
  runtimeId: 'runtime-ready',
  health: { websocket: 'ready', runtime: 'ready', graph: 'ready' }
}
const userQuit = { type: 'orca:serve-user-quit' }

afterEach(() => vi.useRealTimers())

describe('committed serve user quit monitor', () => {
  it('does not extend the exit deadline for duplicate committed quit messages', async () => {
    vi.useFakeTimers()
    const child = new Child()
    const result = waitForForegroundServeChild(child as never, null, {
      healthCheckIntervalMs: 10,
      healthProbeTimeoutMs: 1_000,
      healthFailureLimit: 1
    })
    child.emit('message', userQuit)
    await vi.advanceTimersByTimeAsync(20_000)
    child.emit('message', userQuit)
    await vi.advanceTimersByTimeAsync(SERVE_SUPERVISED_SHUTDOWN_GRACE_MS - 20_001)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    child.emit('exit', null, 'SIGKILL')
    await expect(result).resolves.toMatchObject({ userQuitRequested: true, signal: 'SIGKILL' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels health scheduling and ignores an unhealthy probe that settles during teardown', async () => {
    vi.useFakeTimers()
    const child = new Child()
    let finishProbe!: (health: ServeRuntimeHealth) => void
    const lateProbe = new Promise<ServeRuntimeHealth>((resolve) => {
      finishProbe = resolve
    })
    const healthProbe = vi
      .fn()
      .mockResolvedValueOnce({ healthy: true, runtimeId: 'runtime-ready' })
      .mockReturnValue(lateProbe)
    const onVerified = vi.fn(async () => undefined)
    const result = waitForForegroundServeChild(child as never, null, {
      healthProbe,
      onVerified,
      healthCheckIntervalMs: 10,
      healthProbeTimeoutMs: 1_000,
      healthFailureLimit: 1
    })
    child.emit('message', ready)
    await vi.advanceTimersByTimeAsync(0)
    expect(onVerified).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10)
    expect(healthProbe).toHaveBeenCalledTimes(2)

    child.emit('message', userQuit)
    finishProbe({ healthy: false, reason: 'runtime_unreachable' })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(child.kill).not.toHaveBeenCalled()
    expect(healthProbe).toHaveBeenCalledTimes(2)
    child.emit('exit', 0, null)
    await expect(result).resolves.toMatchObject({
      code: 0,
      readiness: 'verified',
      userQuitRequested: true
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels pending readiness without completing an update or terminating a quitting child', async () => {
    vi.useFakeTimers()
    const child = new Child()
    const complete = vi.fn(async () => undefined)
    const recordFailure = vi.fn(async () => undefined)
    const healthProbe = vi.fn()
    const result = waitForForegroundServeChild(
      child as never,
      {
        targetVersion: '1.4.181',
        complete,
        recordFailure
      },
      {
        healthProbe,
        healthCheckIntervalMs: 10,
        healthProbeTimeoutMs: 1_000,
        healthFailureLimit: 1
      }
    )
    child.emit('message', userQuit)
    child.emit('message', ready)
    await vi.advanceTimersByTimeAsync(SERVE_SUPERVISED_SHUTDOWN_GRACE_MS - 1)
    expect(child.kill).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(recordFailure).not.toHaveBeenCalled()
    expect(healthProbe).not.toHaveBeenCalled()
    child.emit('exit', 0, null)
    await expect(result).resolves.toMatchObject({ userQuitRequested: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('prioritizes explicit user stop over a pending handoff without replacing the child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-user-quit-handoff-'))
    const handoffPath = getServeUpdateHandoffPath(root)
    const child = new Child()
    const handoff = {
      schemaVersion: 1 as const,
      phase: 'install-requested' as const,
      fromVersion: '1.4.180',
      targetVersion: '1.4.181',
      servingPid: child.pid
    }
    const spawnChild = vi.fn()
    const sleep = vi.fn(async () => undefined)
    try {
      await writeFile(handoffPath, JSON.stringify(handoff))
      const result = superviseForegroundServe({
        child: child as never,
        executable: '/opt/orca/orca',
        childArgs: [],
        spawnOptions: {},
        spawnChild,
        handoffPath,
        expectedHandoff: handoff,
        sleep
      })
      child.emit('message', userQuit)
      child.emit('exit', 0, null)

      await expect(result).resolves.toBe(SERVE_SUPERVISOR_STOP_EXIT_CODE)
      expect(spawnChild).not.toHaveBeenCalled()
      expect(sleep).not.toHaveBeenCalled()
      expect(JSON.parse(await readFile(handoffPath, 'utf8'))).toEqual(handoff)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
