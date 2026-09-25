import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { getActiveViewPreferenceFile } from '../../active-view-preference'
import * as backupWorker from '../profile-state/profile-state-backup-worker'
import { profileStateDatabaseBackups } from '../profile-state/profile-state-backup-path'
import {
  createJsonMaintenanceFixture,
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

describe('profile maintenance admission', () => {
  it('drains accepted writes and captures newer edits after blocking new durable operations', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const gate = maintenanceBarrier()
    const started = maintenanceBarrier()
    const write = authority.writeSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      started.resolve()
      await gate.promise
      await write(domains)
    })
    const accepted = store.runDurableMutation(() => {
      store.updateSettings({ theme: 'dark' })
      return { value: 'accepted' }
    })
    await started.promise
    const stopped = vi.spyOn(authority, 'close')
    const paused = store.beginProfileMaintenance()
    const refused = vi.fn(() => ({ value: undefined }))
    await expect(store.runDurableMutation(refused)).rejects.toThrow('finalized')
    expect(refused).not.toHaveBeenCalled()
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
    await expect(store.writeLatestProfileStateJsonExportAsync()).rejects.toThrow('finalized')
    expect(() => store.stageWorkspaceSessionBeforeUnload(store.getWorkspaceSession())).toThrow(
      'maintenance'
    )
    store.updateSettings({ theme: 'light' })
    store.getWorkspaceSession().activeTabId = 'during-maintenance'
    expect(stopped).not.toHaveBeenCalled()
    gate.resolve()
    await expect(accepted).resolves.toBe('accepted')
    const maintenance = await paused
    expect(stopped).toHaveBeenCalledOnce()
    expect(readState()).toMatchObject({
      settings: { theme: 'light' },
      workspaceSession: { activeTabId: 'during-maintenance' }
    })
    store.updateSettings({ theme: 'dark' })
    await maintenance.resume()
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.theme).toBe('dark')
    await expect(maintenance.resume()).rejects.toThrow('finalization')
  })

  it('refuses re-admission after a competing write without adopting its revision', async () => {
    const { store, peer, readState } = await createWorkerMaintenanceFixture()
    store.updateSettings({ theme: 'dark' })
    const maintenance = await store.beginProfileMaintenance()
    const writer = peer()
    try {
      writer.readSerializedState()
      writer.writeSerializedDomains([{ domain: 'peer', payload: '{"preserved":true}' }])
    } finally {
      writer.close()
    }
    await expect(maintenance.resume()).rejects.toThrow('Profile state revision changed')
    const mutate = vi.fn(() => ({ value: undefined }))
    await expect(store.runDurableMutation(mutate)).rejects.toThrow('finalized')
    expect(mutate).not.toHaveBeenCalled()
    expect(readState().peer).toEqual({ preserved: true })
  })

  it.each(['maintenance', 'freeze', 'final'] as const)(
    '%s waits for an admitted flush between SQL passes',
    async (kind) => {
      const { store, authority, readState } = await createWorkerMaintenanceFixture()
      const started = maintenanceBarrier()
      const release = maintenanceBarrier()
      vi.spyOn(authority, 'drainBackups').mockImplementationOnce(async () => {
        started.resolve()
        await release.promise
      })
      store.updateSettings({ theme: 'dark' })
      const older = store.flushPendingOrThrowAsync()
      await started.promise
      store.updateSettings({ theme: 'light' })
      const capture = vi.spyOn(authority, 'writeCompleteSerializedDomains')
      const close = vi.spyOn(authority, 'close')
      const paused =
        kind === 'maintenance'
          ? store.beginProfileMaintenance()
          : kind === 'freeze'
            ? store.freezeWritesAsync()
            : store.flushFinalOrThrowAsync()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(capture).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
      release.resolve()
      await older
      await paused
      expect(close).toHaveBeenCalled()
      expect(readState().settings.theme).toBe('light')
    }
  )

  it.each(['maintenance', 'freeze', 'final'] as const)(
    '%s waits for accepted retries after another flush reports a known failure',
    async (kind) => {
      const { store, authority, readState } = await createWorkerMaintenanceFixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const started = maintenanceBarrier()
      const release = maintenanceBarrier()
      vi.spyOn(authority, 'drainBackups').mockImplementationOnce(async () => {
        started.resolve()
        await release.promise
      })
      store.updateSettings({ theme: 'dark' })
      const accepted = store.flushPendingOrThrowAsync()
      await started.promise
      store.updateSettings({ theme: 'light' })
      const failureStarted = maintenanceBarrier()
      const fail = maintenanceBarrier()
      vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async () => {
        failureStarted.resolve()
        await fail.promise
        throw new Error('disk refused')
      })
      const failed = expect(
        store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      ).rejects.toThrow('disk refused')
      await failureStarted.promise
      const close = vi.spyOn(authority, 'close')
      const paused =
        kind === 'maintenance'
          ? store.beginProfileMaintenance()
          : kind === 'freeze'
            ? store.freezeWritesAsync()
            : store.flushFinalOrThrowAsync()
      fail.resolve()
      await failed
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(close).not.toHaveBeenCalled()
      release.resolve()
      await accepted
      await paused
      expect(close).toHaveBeenCalledOnce()
      expect(readState().settings.theme).toBe('light')
    }
  )

  it('cancels a backup and waits for its worker to exit before releasing maintenance', async () => {
    const { store, authority, databaseFile } = await createWorkerMaintenanceFixture()
    const started = maintenanceBarrier()
    const canceled = maintenanceBarrier()
    const release = maintenanceBarrier()
    vi.spyOn(backupWorker, 'runProfileStateBackupWorker').mockImplementationOnce(
      async (_job, options) => {
        started.resolve()
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        )
        canceled.resolve()
        await release.promise
        throw new Error('backup aborted')
      }
    )
    await store.runDurableMutation(() => {
      store.updateSettings({ theme: 'dark' })
      return { value: undefined }
    })
    await started.promise
    const close = vi.spyOn(authority, 'close')
    const paused = store.beginProfileMaintenance()
    let done = false
    void paused.then(() => {
      done = true
    })
    await canceled.promise
    expect(done).toBe(false)
    expect(close).not.toHaveBeenCalled()
    release.resolve()
    await paused
    expect(close).toHaveBeenCalledOnce()
    expect(profileStateDatabaseBackups(databaseFile)).toHaveLength(0)
  })

  it('drains an accepted flush before rejecting canceled maintenance', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    vi.spyOn(authority, 'drainBackups').mockImplementationOnce(async () => {
      started.resolve()
      await release.promise
    })
    store.updateSettings({ theme: 'dark' })
    const accepted = store.flushPendingOrThrowAsync()
    await started.promise
    store.updateSettings({ theme: 'light' })
    const close = vi.spyOn(authority, 'close')
    const controller = new AbortController()
    controller.abort()
    const rejected = expect(
      store.beginProfileMaintenance({ signal: controller.signal })
    ).rejects.toThrow('aborted')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(close).not.toHaveBeenCalled()
    release.resolve()
    await accepted
    await rejected
    expect(close).toHaveBeenCalledOnce()
    expect(readState().settings.theme).toBe('light')
  })

  it('joins an ongoing maintenance close at final shutdown without reopening or rewriting', async () => {
    const { store, authority } = await createWorkerMaintenanceFixture()
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const close = authority.close.bind(authority)
    vi.spyOn(authority, 'close').mockImplementationOnce(async () => {
      started.resolve()
      await release.promise
      await close()
    })
    const paused = store.beginProfileMaintenance()
    await started.promise
    const write = vi.spyOn(authority, 'writeCompleteSerializedDomains')
    const final = store.flushFinalOrThrowAsync()
    release.resolve()
    const maintenance = await paused
    await final
    expect(write).not.toHaveBeenCalled()
    await expect(maintenance.resume()).rejects.toThrow('finalization')
  })

  it('quarantines a faulted worker only after closing it, without writing current memory', async () => {
    const { store, authority, directory, readState } = await createWorkerMaintenanceFixture()
    const durable = readState()
    store.updateSettings({ theme: durable.settings.theme === 'dark' ? 'light' : 'dark' })
    await authority.abort()
    const result = await store.quarantineProfileStateDatabaseAsync(directory, 'worker-failure')
    expect(result.copiedFiles.some((path) => path.endsWith('profile-state.db'))).toBe(true)
    expect(readState()).toEqual(durable)
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
  })

  it('never provides a resume token after a faulted normal-maintenance attempt', async () => {
    const { store, authority } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await authority.abort()
    await expect(store.beginProfileMaintenance()).rejects.toThrow('aborted')
    await expect(store.beginProfileMaintenance()).rejects.toThrow('already stopped')
  })

  it('pauses JSON and preference timers, then persists edits after unchanged-source resume', async () => {
    const { store, dataFile } = createJsonMaintenanceFixture()
    const maintenance = await store.beginProfileMaintenance()
    const before = readFileSync(dataFile)
    const preference = getActiveViewPreferenceFile(dataFile)
    const preferenceBefore = readFileSync(preference)
    vi.useFakeTimers()
    store.updateSettings({ theme: 'dark' })
    store.updateUI({ activeView: 'settings' })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(readFileSync(dataFile)).toEqual(before)
    expect(readFileSync(preference)).toEqual(preferenceBefore)
    vi.useRealTimers()
    await maintenance.resume()
    await store.flushPendingOrThrowAsync()
    expect(JSON.parse(readFileSync(dataFile, 'utf8')).settings.theme).toBe('dark')
    expect(JSON.parse(readFileSync(preference, 'utf8')).activeView).toBe('settings')
  })

  it('refuses legacy JSON resume if the source changed during maintenance', async () => {
    const { store, dataFile } = createJsonMaintenanceFixture()
    const maintenance = await store.beginProfileMaintenance()
    writeFileSync(dataFile, '{"peer":true}')
    await expect(maintenance.resume()).rejects.toThrow('Profile storage changed')
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
    expect(readFileSync(dataFile, 'utf8')).toBe('{"peer":true}')
  })
})
