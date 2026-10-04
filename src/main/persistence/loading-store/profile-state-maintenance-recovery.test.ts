import { describe, expect, it, vi } from 'vitest'
import * as backupWorker from '../profile-state/profile-state-backup-worker'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('failed maintenance recovery', () => {
  it.each(['maintenance', 'final', 'freeze'] as const)(
    '%s cancels an active backup after a routine flush completes',
    async (kind) => {
      const { store } = await createWorkerMaintenanceFixture()
      const started = maintenanceBarrier()
      const canceled = maintenanceBarrier()
      vi.spyOn(backupWorker, 'runProfileStateBackupWorker').mockImplementationOnce(
        async (_job, options) => {
          started.resolve()
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener('abort', () => resolve(), { once: true })
          )
          canceled.resolve()
          throw new Error('backup aborted')
        }
      )
      await store.runDurableMutation(() => {
        store.updateSettings({ theme: 'dark' })
        return { value: undefined }
      })
      await started.promise
      await store.flushPendingOrThrowAsync()
      const stop =
        kind === 'maintenance'
          ? store.beginProfileMaintenance()
          : kind === 'final'
            ? store.flushFinalOrThrowAsync()
            : store.freezeWritesAsync()
      await canceled.promise
      await stop
    }
  )

  it('cancels between checkpoints without aborting an acknowledged write', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const write = authority.writeCompleteSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeCompleteSerializedDomains').mockImplementationOnce(
      async (domains) => {
        started.resolve()
        await release.promise
        await write(domains)
      }
    )
    const abort = vi.spyOn(authority, 'abort')
    const controller = new AbortController()
    store.updateSettings({ theme: 'dark' })
    const pending = store.beginProfileMaintenance({ signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('aborted')
    await started.promise
    controller.abort()
    release.resolve()
    await rejected
    expect(abort).not.toHaveBeenCalled()
    store.setWorkspaceSession({ ...store.getWorkspaceSession(), activeTabId: 'after-cancellation' })
    await store.flushPendingOrThrowAsync()
    expect(readState()).toMatchObject({
      settings: { theme: 'dark' },
      workspaceSession: { activeTabId: 'after-cancellation' }
    })
  })

  it('restores the writer and snapshot admission after a known failed checkpoint', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(authority, 'writeCompleteSerializedDomains').mockRejectedValueOnce(
      new Error('disk refused')
    )
    store.updateSettings({ theme: 'dark' })
    await expect(store.beginProfileMaintenance()).rejects.toThrow('disk refused')

    store.setWorkspaceSession({ ...store.getWorkspaceSession(), activeTabId: 'after-failure' })
    await store.runDurableMutation(() => {
      store.updateSettings({ theme: 'light' })
      return { value: undefined }
    })
    expect(readState()).toMatchObject({
      settings: { theme: 'light' },
      workspaceSession: { activeTabId: 'after-failure' }
    })
    await (await store.beginProfileMaintenance()).resume()
  })

  it('keeps changed storage fenced when recovering a known failure', async () => {
    const { store, authority, peer, readState } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    store.updateSettings({ theme: 'dark' })
    vi.spyOn(authority, 'writeCompleteSerializedDomains').mockImplementationOnce(async () => {
      const writer = peer()
      writer.writeSerializedDomains([{ domain: 'peer', payload: '{"preserved":true}' }])
      writer.close()
      throw new Error('disk refused')
    })
    await expect(store.beginProfileMaintenance()).rejects.toThrow('disk refused')
    await expect(store.runDurableMutation(() => ({ value: undefined }))).rejects.toThrow(
      'finalized'
    )
    expect(readState().peer).toEqual({ preserved: true })
  })

  it('does not extend the maintenance checkpoint for unadmitted saves', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    store.updateSettings({ theme: 'dark' })
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const write = authority.writeCompleteSerializedDomains.bind(authority)
    const checkpoint = vi
      .spyOn(authority, 'writeCompleteSerializedDomains')
      .mockImplementationOnce(async (domains) => {
        started.resolve()
        await release.promise
        await write(domains)
      })
    const pending = store.beginProfileMaintenance()
    await started.promise
    for (let terminalFontSize = 12; terminalFontSize < 32; terminalFontSize++) {
      store.updateSettings({ terminalFontSize })
    }
    release.resolve()
    const maintenance = await pending
    expect(checkpoint).toHaveBeenCalledOnce()
    await maintenance.resume()
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.terminalFontSize).toBe(31)
  })
})
