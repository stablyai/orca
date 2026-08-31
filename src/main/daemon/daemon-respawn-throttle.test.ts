import { describe, expect, it, vi } from 'vitest'
import { DaemonSpawner, type DaemonProcessHandle } from './daemon-spawner'
import { DaemonCrashLoopError, DaemonRespawnThrottle } from './daemon-respawn-throttle'

describe('DaemonRespawnThrottle', () => {
  it('admits up to the cap, then refuses with the time left in the window', () => {
    let now = 0
    const throttle = new DaemonRespawnThrottle({
      maxAttempts: 3,
      windowMs: 1_000,
      now: () => now
    })
    expect(throttle.admit().allowed).toBe(true)
    now = 200
    expect(throttle.admit().allowed).toBe(true)
    now = 400
    expect(throttle.admit().allowed).toBe(true)
    now = 500
    const refused = throttle.admit()
    expect(refused).toEqual({
      allowed: false,
      reason: 'crash_loop',
      attemptsInWindow: 3,
      retryAfterMs: 500
    })
  })

  it('admits again once the window slides past the oldest attempt', () => {
    let now = 0
    const throttle = new DaemonRespawnThrottle({ maxAttempts: 2, windowMs: 1_000, now: () => now })
    throttle.admit()
    throttle.admit()
    expect(throttle.admit().allowed).toBe(false)
    now = 1_500
    expect(throttle.admit().allowed).toBe(true)
  })

  it('clears the window on an explicit reset (the operator-restart escape hatch)', () => {
    const throttle = new DaemonRespawnThrottle({ maxAttempts: 1, windowMs: 60_000 })
    expect(throttle.admit().allowed).toBe(true)
    expect(throttle.admit().allowed).toBe(false)
    throttle.reset()
    expect(throttle.admit().allowed).toBe(true)
  })
})

describe('DaemonSpawner crash-loop containment', () => {
  const handle: DaemonProcessHandle = { shutdown: async () => {} }

  it('stops forking once the daemon has died repeatedly inside the window', async () => {
    const launcher = vi.fn(async () => handle)
    const spawner = new DaemonSpawner({
      runtimeDir: '/tmp/orcad-throttle-test',
      launcher,
      respawnThrottle: new DaemonRespawnThrottle({ maxAttempts: 3, windowMs: 60_000 })
    })
    for (let i = 0; i < 3; i += 1) {
      await spawner.ensureRunning()
      // What a dead daemon looks like to the adapter's respawn path.
      spawner.resetHandle()
    }
    expect(launcher).toHaveBeenCalledTimes(3)
    await expect(spawner.ensureRunning()).rejects.toBeInstanceOf(DaemonCrashLoopError)
    // The refusal must actually prevent the fork, not just annotate it.
    expect(launcher).toHaveBeenCalledTimes(3)
  })

  it('does not count a cached handle as a new attempt', async () => {
    const launcher = vi.fn(async () => handle)
    const spawner = new DaemonSpawner({
      runtimeDir: '/tmp/orcad-throttle-test',
      launcher,
      respawnThrottle: new DaemonRespawnThrottle({ maxAttempts: 2, windowMs: 60_000 })
    })
    await spawner.ensureRunning()
    await spawner.ensureRunning()
    await spawner.ensureRunning()
    expect(launcher).toHaveBeenCalledTimes(1)
  })

  it('lets an operator restart clear containment', async () => {
    const launcher = vi.fn(async () => handle)
    const spawner = new DaemonSpawner({
      runtimeDir: '/tmp/orcad-throttle-test',
      launcher,
      respawnThrottle: new DaemonRespawnThrottle({ maxAttempts: 1, windowMs: 60_000 })
    })
    await spawner.ensureRunning()
    spawner.resetHandle()
    await expect(spawner.ensureRunning()).rejects.toBeInstanceOf(DaemonCrashLoopError)
    spawner.resetRespawnWindow()
    await expect(spawner.ensureRunning()).resolves.toBeDefined()
    expect(launcher).toHaveBeenCalledTimes(2)
  })
})
