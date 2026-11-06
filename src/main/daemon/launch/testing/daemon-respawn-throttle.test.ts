import { describe, expect, it, vi } from 'vitest'
import { DaemonSpawner, type DaemonProcessHandle } from '../daemon-spawner'
import { DaemonCrashLoopError, DaemonRespawnThrottle } from '../daemon-respawn-throttle'

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
      // Model daemon loss so the next ensureRunning must launch again.
      spawner.resetHandle()
    }
    expect(launcher).toHaveBeenCalledTimes(3)
    await expect(spawner.ensureRunning()).rejects.toBeInstanceOf(DaemonCrashLoopError)
    expect(launcher).toHaveBeenCalledTimes(3)
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
