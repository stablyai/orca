import {
  admitDetachedWorkspaceSessionInput,
  patchDetachedWorkspaceSession
} from './loading-store/workspace-sessions/session-snapshot-operations'
import { borrowWorkspaceSession } from './loading-store/workspace-sessions/session-host-partitions'
import { describe, it, expect, vi } from 'vitest'

import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './loading-store/profile-writing/profile-state-maintenance-fixture'
import type { ProfileStateWorkerAuthority } from './profile-state/profile-state-worker-authority'
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

function pauseCommit(authority: ProfileStateWorkerAuthority) {
  const started = maintenanceBarrier()
  const finish = maintenanceBarrier()
  const original = authority.writePreparedState.bind(authority)
  vi.spyOn(authority, 'writePreparedState').mockImplementationOnce(async (write) => {
    started.resolve()
    await finish.promise
    await original(write)
  })
  return { started: started.promise, release: finish.resolve }
}

describe('worker persistence avoids synchronous profile filesystem calls', () => {
  it('rewrites an earlier value after a captured stale generation commits', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    store.updateUI({ sidebarWidth: 641 })
    await store.flushPendingOrThrowAsync()
    const gate = pauseCommit(authority)
    store.updateUI({ sidebarWidth: 642 })
    const pending = store.flushPendingAsync()
    await gate.started
    store.updateUI({ sidebarWidth: 641 })
    gate.release()
    await pending
    expect(readState().ui.sidebarWidth).toBe(642)
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    expect(readState().ui.sidebarWidth).toBe(641)
  })
  it('saves a retained getter edit after ACK and an unrelated detached publication', async () => {
    const { store, readState } = await createWorkerMaintenanceFixture()
    const retained = store.getWorkspaceSession()
    retained.activeTabIdByWorktree = { w: 'before' }
    patchDetachedWorkspaceSession(store, { activeTabId: 'initial' })
    await store.flushPendingOrThrowAsync()
    retained.activeTabIdByWorktree.w = 'after-ack'
    patchDetachedWorkspaceSession(store, { activeTabId: 'next' })
    await store.flushPendingOrThrowAsync()
    expect(readState().workspaceSession.activeTabIdByWorktree.w).toBe('after-ack')
  })

  it('keeps exposure while C is in flight after its ACK', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const gate = pauseCommit(authority)
    const input = { activeTabIdByWorktree: { w: 'C' } }
    admitDetachedWorkspaceSessionInput(store, input)
    patchDetachedWorkspaceSession(store, input)
    const pending = store.flushPendingAsync()
    await gate.started
    const exposed = store.getWorkspaceSession()
    exposed.activeTabIdByWorktree!.w = 'D'
    gate.release()
    await pending
    patchDetachedWorkspaceSession(store, { activeTabId: 'unrelated' })
    await store.flushPendingOrThrowAsync()
    expect(readState().workspaceSession.activeTabIdByWorktree.w).toBe('D')
  })

  it('captures newer detached D after C commits without granting a caller alias ownership', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const gate = pauseCommit(authority)
    patchDetachedWorkspaceSession(store, { activeTabId: 'C' })
    const pending = store.flushPendingAsync()
    await gate.started
    patchDetachedWorkspaceSession(store, { activeTabId: 'D' })
    gate.release()
    await pending
    expect(readState().workspaceSession.activeTabId).toBe('C')
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    expect(readState().workspaceSession.activeTabId).toBe('D')
    const held = { ...borrowWorkspaceSession(store), activeTabIdByWorktree: { w: 'caller' } }
    store.setWorkspaceSession(held)
    await store.flushPendingOrThrowAsync()
    held.activeTabIdByWorktree.w = 'caller-after-ack'
    patchDetachedWorkspaceSession(store, { activeTabId: 'final' })
    await store.flushPendingOrThrowAsync()
    expect(readState().workspaceSession.activeTabIdByWorktree.w).toBe('caller-after-ack')
  })
})
