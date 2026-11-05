import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DaemonServer } from '../../../server/daemon-server'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { getDaemonSocketPath } from '../../../launch/daemon-spawner'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'

it('reconnects pending surface work with zero published PTYs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-pending-reconnect-'))
  const socketPath = getDaemonSocketPath(root)
  const tokenPath = join(root, 'test.token')
  const spawned = vi.fn(() => createMockSubprocess())
  let server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess: spawned })
  await server.start()
  const respawn = vi.fn(async () => {
    server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess: spawned })
    await server.start()
  })
  const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
  const reconnected = Promise.withResolvers<void>()
  let recovering = false
  const stopWake = adapter.surfaceExecution.onWake(() => {
    if (recovering) {
      reconnected.resolve()
    }
  })
  const release = adapter.surfaceExecution.retainRecoveryInterest()
  try {
    const candidate = {
      scope: { databasePath: join(root, 'unused-profile.db'), profileId: 'pending-test' },
      hostId: 'local',
      allocationId: 'pending-run',
      resourceId: 'pending-resource'
    }
    const original = await adapter.surfaceExecution.identify(candidate)
    expect(original?.executorId).toBeTruthy()
    recovering = true
    await server.shutdown()
    await reconnected.promise
    expect(respawn).toHaveBeenCalledTimes(1)
    expect(spawned).not.toHaveBeenCalled()
    expect((await adapter.surfaceExecution.identify(candidate))?.executorId).not.toBe(
      original?.executorId
    )
    release()
    release()
  } finally {
    release()
    stopWake()
    adapter.dispose()
    await server.shutdown()
    rmSync(root, { recursive: true, force: true })
  }
})
