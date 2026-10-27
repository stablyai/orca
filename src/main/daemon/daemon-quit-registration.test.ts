import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { runQuitTasks } from '../quit-task-registry'
import { disconnectDaemon, installDaemonProvider } from './daemon-provider-state'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonSpawner } from './daemon-spawner'

afterEach(async () => {
  await disconnectDaemon()
  vi.restoreAllMocks()
})

it.each([false, true])(
  'cleans up only an installed daemon with dev shutdown=%s',
  async (shutdownDaemon) => {
    const adapter = createAdapter('persistent', ['terminal'])
    const spawner = new DaemonSpawner({
      runtimeDir: tmpdir(),
      launcher: async () => ({ shutdown: async () => {} })
    })
    const shutdown = vi.spyOn(spawner, 'shutdown').mockResolvedValue()
    const context = { isUpdate: false, shutdownDaemon }
    await runQuitTasks('daemon', context)
    expect(adapter.disconnectOnly).not.toHaveBeenCalled()
    expect(adapter.dispose).not.toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()

    installDaemonProvider(spawner, adapter)
    await runQuitTasks('daemon', context)
    if (shutdownDaemon) {
      expect(adapter.dispose).toHaveBeenCalledOnce()
      expect(adapter.disconnectOnly).not.toHaveBeenCalled()
      expect(shutdown).toHaveBeenCalledOnce()
      expect(vi.mocked(adapter.dispose).mock.invocationCallOrder[0]).toBeLessThan(
        shutdown.mock.invocationCallOrder[0]!
      )
    } else {
      expect(adapter.disconnectOnly).toHaveBeenCalledOnce()
      expect(adapter.dispose).not.toHaveBeenCalled()
      expect(shutdown).not.toHaveBeenCalled()
    }
  }
)
