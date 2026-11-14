import {
  admitDetachedWorkspaceSessionInput,
  patchDetachedWorkspaceSession,
  setDetachedWorkspaceSession
} from './loading-store/workspace-sessions/session-snapshot-operations'
import { borrowWorkspaceSession } from './loading-store/workspace-sessions/session-host-partitions'
import { describe, it, expect, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../shared/constants'
import { makeSessionWithTerminalBuffers } from './persistence-session-fixtures'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'

import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './loading-store/profile-writing/profile-state-maintenance-fixture'
import { clearSshRemotePtyBindingsForLeases } from './leasing-ssh-ptys/ssh-pty-binding-cleanup'
import { scheduleSave } from './loading-store/profile-writing/write-scheduling'
import type { Store } from './loading-store/store'
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

function clearOwnedBinding(store: Store): void {
  clearSshRemotePtyBindingsForLeases(
    {
      state: {
        ...getDefaultPersistedState('/synthetic'),
        workspaceSession: borrowWorkspaceSession(store)
      },
      toComparablePtyId: (_target, ptyId) => ptyId,
      scheduleSave: () => scheduleSave(store, ['workspaceSession'])
    },
    'field-test',
    [
      {
        targetId: 'field-test',
        ptyId: 'local-pty',
        state: 'terminated',
        createdAt: 1,
        updatedAt: 1
      }
    ]
  )
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
  it.each(['local', 'ssh:field-test'])(
    'bounds an owned tab save by its fields at 100 and 1000 workspaces (%s)',
    async (hostId) => {
      for (const size of [100, 1000]) {
        const { store, authority, readState } = await createWorkerMaintenanceFixture()
        const session = {
          ...getDefaultWorkspaceSession(),
          activeTabIdByWorktree: { w: 'before' },
          openFilesByWorktree: Object.fromEntries(
            Array.from({ length: size }, (_, index) => [
              `w${index}`,
              [
                {
                  filePath: `/synthetic/${index}`,
                  relativePath: String(index),
                  worktreeId: `w${index}`,
                  language: 'plaintext',
                  dirtyDraftContent: 'unrelated'.repeat(100)
                }
              ]
            ])
          )
        }
        admitDetachedWorkspaceSessionInput(store, session, hostId)
        setDetachedWorkspaceSession(store, session, hostId)
        await store.flushPendingOrThrowAsync()
        const writes = vi.spyOn(authority, 'writePreparedState')
        const patch = { activeTabIdByWorktree: { w: 'after' } }
        admitDetachedWorkspaceSessionInput(store, patch, hostId)
        patchDetachedWorkspaceSession(store, patch, hostId)
        await store.flushPendingOrThrowAsync()
        const write = writes.mock.calls[0]?.[0]
        expect(write?.replacements).toEqual([])
        expect(write?.patches).toEqual([
          {
            domain: hostId === 'local' ? 'workspaceSession' : 'workspaceSessionsByHostId',
            operations: [
              {
                kind: 'set',
                path:
                  hostId === 'local'
                    ? ['activeTabIdByWorktree']
                    : [hostId, 'activeTabIdByWorktree'],
                payload: '{"w":"after"}'
              }
            ]
          }
        ])
        const saved =
          hostId === 'local'
            ? readState().workspaceSession
            : readState().workspaceSessionsByHostId[hostId]
        expect(saved.activeTabIdByWorktree.w).toBe('after')
        expect(Object.keys(saved.openFilesByWorktree)).toHaveLength(size)
        expect(saved.openFilesByWorktree.w0[0].dirtyDraftContent).toBe('unrelated'.repeat(100))
        writes.mockRestore()
      }
    }
  )

  it.each([false, true])(
    'persists next-save in-place cleanup with a field publication, reentrant=%s',
    async (reentrant) => {
      const { store, readState } = await createWorkerMaintenanceFixture()
      const input = makeSessionWithTerminalBuffers()
      admitDetachedWorkspaceSessionInput(store, input)
      setDetachedWorkspaceSession(store, input)
      await store.flushPendingOrThrowAsync()
      if (reentrant) {
        const stop = store.onWorkspaceSessionWritten(() => {
          stop()
          clearOwnedBinding(store)
        })
      } else {
        clearOwnedBinding(store)
      }
      patchDetachedWorkspaceSession(store, { activeTabId: 'next' })
      await store.flushPendingOrThrowAsync()
      const saved = readState().workspaceSession
      expect(saved.tabsByWorktree['local-repo::/local'][0].ptyId).toBeNull()
      expect(saved.terminalLayoutsByTabId['local-tab'].ptyIdsByLeafId).toEqual({})
      expect(saved.activeTabId).toBe('next')
    }
  )

  it('restores a failed field capture without downgrading newer in-place cleanup', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const input = makeSessionWithTerminalBuffers()
    admitDetachedWorkspaceSessionInput(store, input)
    setDetachedWorkspaceSession(store, input)
    await store.flushPendingOrThrowAsync()
    const started = maintenanceBarrier()
    const reject = maintenanceBarrier()
    vi.spyOn(authority, 'writePreparedState').mockImplementationOnce(async () => {
      started.resolve()
      await reject.promise
      throw new Error('known failure')
    })
    patchDetachedWorkspaceSession(store, { activeTabId: 'retry' })
    const failed = expect(
      store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    ).rejects.toThrow('known failure')
    await started.promise
    clearOwnedBinding(store)
    reject.resolve()
    await failed
    await store.flushPendingOrThrowAsync()
    const saved = readState().workspaceSession
    expect(saved.activeTabId).toBe('retry')
    expect(saved.tabsByWorktree['local-repo::/local'][0].ptyId).toBeNull()
    expect(saved.terminalLayoutsByTabId['local-tab'].ptyIdsByLeafId).toEqual({})
  })

  it('persists an alias retained by a refused layout admission before a detached patch', async () => {
    const { store, readState } = await createWorkerMaintenanceFixture()
    const input = makeSessionWithTerminalBuffers()
    admitDetachedWorkspaceSessionInput(store, input)
    setDetachedWorkspaceSession(store, input)
    await store.flushPendingOrThrowAsync()
    let retained: WorkspaceSessionState | undefined
    const result = await store.applyLayoutCommand(
      {
        type: 'renameTab',
        workspace: 'local-repo::/local',
        tabId: 'local-tab',
        kind: 'generated',
        title: 'refused'
      },
      [],
      {
        admit: (partitions) => {
          retained = partitions?.[0]
          return false
        }
      }
    )
    expect(result.ok).toBe(false)
    if (!retained) {
      throw new Error('Admission did not receive its partition')
    }
    retained.tabsByWorktree['local-repo::/local'][0].title = 'retained after refusal'
    patchDetachedWorkspaceSession(store, { activeTabId: 'later' })
    await store.flushPendingOrThrowAsync()
    expect(readState().workspaceSession.tabsByWorktree['local-repo::/local'][0].title).toBe(
      'retained after refusal'
    )
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
