import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { expect, it, vi } from 'vitest'
import { agentModelCatalogStore } from '../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogService } from '../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { agentSessionRecordFixture } from '../../native-chat/agent-session-record-test-fixture'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'

export function registerDurableSettingsWriteTests(): void {
  it('revokes reports captured under a transient command when the durable write rolls back', async () => {
    const { store, authority } = await createWorkerMaintenanceFixture()
    const record = agentSessionRecordFixture({
      sessionId: 'session-settings-rollback',
      provider: 'grok',
      accountHome: { variable: 'GROK_HOME', path: '/settings-rollback/grok' }
    })
    const catalog = createAgentModelCatalogService({
      store: agentModelCatalogStore,
      getConversation: () => {
        const held = record
        return held ? agentSessionConversationView(held) : undefined
      },
      getRecord: () => record,
      drivesRecord: () => true,
      resolveAccountHome: async () => record.accountHome,
      probes: {}
    })
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async () => {
      started.resolve()
      await release.promise
      throw new Error('Disk full')
    })
    const original = catalog.captureSource(record)
    const previous = store.getSettings().agentCmdOverrides
    try {
      const pending = store.updateSettingsAndFlush({ agentCmdOverrides: { grok: 'grok-other' } })
      const rejected = expect(pending).rejects.toThrow('Disk full')
      await started.promise
      expect(original()).toBe(false)
      const transient = catalog.captureSource(record)
      expect(transient()).toBe(true)
      release.resolve()
      await rejected
      expect(store.getSettings().agentCmdOverrides).toEqual(previous)
      expect(transient()).toBe(false)
      expect(catalog.captureSource(record)()).toBe(true)
    } finally {
      release.resolve()
      catalog.stop()
    }
  })

  it('waits for the SQLite write before returning or publishing the preference', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const write = authority.writeSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      started.resolve()
      await release.promise
      await write(domains)
    })
    const onChanged = vi.fn()
    store.onSettingsChanged(onChanged)
    let settled = false
    const pending = store.updateSettingsAndFlush(
      { alwaysForceDeleteWorktrees: true },
      { notifyListeners: true, originWebContentsId: 7 }
    )
    void pending.then(() => {
      settled = true
    })
    await started.promise
    expect(settled).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
    store.updateSettings({ theme: 'dark' })
    release.resolve()
    expect((await pending).theme).toBe('dark')
    expect(readState().settings.alwaysForceDeleteWorktrees).toBe(true)
    expect(onChanged).toHaveBeenCalledWith(
      { alwaysForceDeleteWorktrees: true },
      expect.objectContaining({ alwaysForceDeleteWorktrees: true }),
      7
    )
  })

  it('rejects a failed disk write and rolls back without publishing the preference', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const previous = store.getSettings().alwaysForceDeleteWorktrees
    vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValueOnce(new Error('Disk full'))
    const onChanged = vi.fn()
    store.onSettingsChanged(onChanged)
    await expect(
      store.updateSettingsAndFlush({ alwaysForceDeleteWorktrees: true }, { notifyListeners: true })
    ).rejects.toThrow('Disk full')
    expect(store.getSettings().alwaysForceDeleteWorktrees).toBe(previous)
    expect(readState().settings.alwaysForceDeleteWorktrees).toBe(previous)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('rolls back the preference while retaining unrelated concurrent settings edits', async () => {
    const { store, authority } = await createWorkerMaintenanceFixture()
    const previous = store.getSettings().alwaysForceDeleteWorktrees
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async () => {
      started.resolve()
      await release.promise
      throw new Error('Disk full')
    })
    const pending = store.updateSettingsAndFlush({ alwaysForceDeleteWorktrees: true })
    const rejected = expect(pending).rejects.toThrow('Disk full')
    await started.promise
    store.updateSettings({ theme: 'dark' })
    release.resolve()
    await rejected
    expect(store.getSettings()).toMatchObject({
      alwaysForceDeleteWorktrees: previous,
      theme: 'dark'
    })
  })

  it('removes previously absent optional keys after a failed preference payload write', async () => {
    const { store, authority } = await createWorkerMaintenanceFixture()
    delete store.getSettings().editorWordWrap
    const previous = store.getSettings().alwaysForceDeleteWorktrees
    vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValueOnce(new Error('Disk full'))
    await expect(
      store.updateSettingsAndFlush({ alwaysForceDeleteWorktrees: true, editorWordWrap: false })
    ).rejects.toThrow('Disk full')
    expect(Object.hasOwn(store.getSettings(), 'editorWordWrap')).toBe(false)
    expect(store.getSettings().alwaysForceDeleteWorktrees).toBe(previous)
  })
}
