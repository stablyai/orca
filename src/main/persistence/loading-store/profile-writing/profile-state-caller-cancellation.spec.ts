import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { clearMigrationUnsupportedPty } from '../../../agent-hooks/observations/migration-unsupported-pty-state'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'

export function registerProfileStateCallerCancellationTests(): void {
  const MIGRATION_ENTRY = {
    ptyId: 'pty-legacy',
    reason: 'legacy-numeric-pane-key' as const,
    source: 'local' as const,
    updatedAt: 5
  }

  afterEach(() => {
    agentHookServer.clearPaneKeyAliasesForPty('pty-a')
    agentHookServer.clearPaneKeyAliasesForPty('pty-b')
    clearMigrationUnsupportedPty(MIGRATION_ENTRY.ptyId)
  })

  describe('profile flush caller cancellation', () => {
    it('releases a canceled waiter while its admitted write completes and later saving continues', async () => {
      const { store, authority, readState } = await createWorkerMaintenanceFixture()
      const started = maintenanceBarrier()
      const release = maintenanceBarrier()
      const write = authority.writeSerializedDomains.bind(authority)
      vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
        await write(domains)
        started.resolve()
        await release.promise
      })
      const abort = vi.spyOn(authority, 'abort')
      const controller = new AbortController()
      store.updateSettings({ theme: 'dark' })
      const pending = store.flushPendingOrThrowAsync({ signal: controller.signal })
      const rejected = expect(pending).rejects.toThrow('aborted')
      let settled = false
      void pending.catch(() => {
        settled = true
      })
      await started.promise
      controller.abort()
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(abort).not.toHaveBeenCalled()
        expect(settled).toBe(true)
        expect(() => authority.assertWritable()).not.toThrow()
      } finally {
        release.resolve()
        await rejected
      }
      await store.runDurableMutation(() => {
        store.updateSettings({ theme: 'light' })
        return { value: undefined }
      })
      expect(readState().settings.theme).toBe('light')
    })

    it('keeps an abandoned write ordered before the final checkpoint', async () => {
      const { store, authority, readState } = await createWorkerMaintenanceFixture()
      const started = maintenanceBarrier()
      const release = maintenanceBarrier()
      const write = authority.writeSerializedDomains.bind(authority)
      vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
        started.resolve()
        await release.promise
        await write(domains)
      })
      const controller = new AbortController()
      store.updateSettings({ theme: 'dark' })
      const abandoned = store.flushPendingOrThrowAsync({ signal: controller.signal })
      const rejected = expect(abandoned).rejects.toThrow('aborted')
      await started.promise
      controller.abort()
      store.getWorkspaceSession().activeTabId = 'shutdown-edit'
      const capture = vi.spyOn(authority, 'writeCompleteSerializedDomains')
      const final = store.flushFinalOrThrowAsync()
      const result = final.catch((error: unknown) => error)
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(capture).not.toHaveBeenCalled()
      } finally {
        release.resolve()
        await rejected
      }
      await expect(result).resolves.toBeUndefined()
      expect(readState()).toMatchObject({
        settings: { theme: 'dark' },
        workspaceSession: { activeTabId: 'shutdown-edit' }
      })
    })
  })
}
