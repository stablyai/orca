import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { toComparableRelaySshPtyId } from '../../../shared/ssh-pty-id'
import { clearSshRemotePtyBindingsForLeases } from './ssh-pty-binding-cleanup'

function fixture(count: number) {
  const state = getDefaultPersistedState('/home/test')
  state.workspaceSession = getDefaultWorkspaceSession()
  state.workspaceSession.tabsByWorktree.wt = Array.from({ length: count }, (_, i) => ({
    id: `tab-${i}`,
    worktreeId: 'wt',
    ptyId: `pty-${i}`,
    title: '',
    customTitle: null,
    color: null,
    sortOrder: i,
    createdAt: 1
  }))
  const leases: SshRemotePtyLease[] = Array.from({ length: count }, (_, i) => ({
    targetId: 'ssh-one',
    ptyId: `pty-${i}`,
    tabId: `tab-${i}`,
    worktreeId: 'wt',
    state: 'detached',
    createdAt: 1,
    updatedAt: 1
  }))
  return {
    state,
    leases,
    toComparablePtyId: vi.fn((_target: string, ptyId: string) => ptyId),
    scheduleSave: vi.fn()
  }
}

describe('SSH binding cleanup indexing', () => {
  it('normalizes each binding once across a large lease inventory', () => {
    const operations = fixture(1000)
    expect(clearSshRemotePtyBindingsForLeases(operations, 'ssh-one', operations.leases)).toBe(true)
    expect(operations.toComparablePtyId).toHaveBeenCalledTimes(1000)
    expect(
      operations.state.workspaceSession!.tabsByWorktree.wt.every((tab) => tab.ptyId === null)
    ).toBe(true)
    expect(operations.scheduleSave).toHaveBeenCalledTimes(1)
  })

  it('retains foreign hosts and conflicting tab/workspace leases', () => {
    const operations = fixture(4)
    operations.leases[0].targetId = 'ssh-two'
    operations.leases[1].tabId = 'other-tab'
    operations.leases[2].worktreeId = 'other-workspace'
    delete operations.leases[3].tabId
    clearSshRemotePtyBindingsForLeases(operations, 'ssh-one', operations.leases)
    expect(operations.state.workspaceSession!.tabsByWorktree.wt.map((tab) => tab.ptyId)).toEqual([
      'pty-0',
      'pty-1',
      'pty-2',
      null
    ])
  })

  it('matches layout leaves against every lease for a PTY while preserving leaf conflicts', () => {
    const operations = fixture(1)
    const session = operations.state.workspaceSession!
    session.tabsByWorktree.wt[0].ptyId = null
    session.terminalLayoutsByTabId['tab-0'] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        matched: 'pty-0',
        protected: 'pty-0',
        wildcard: 'pty-1'
      }
    }
    const lease = operations.leases[0]
    operations.leases = [
      { ...lease, leafId: 'wrong' },
      { ...lease, leafId: 'matched' },
      { ...lease, ptyId: 'pty-1' }
    ]
    expect(clearSshRemotePtyBindingsForLeases(operations, 'ssh-one', operations.leases)).toBe(true)
    expect(session.terminalLayoutsByTabId['tab-0'].ptyIdsByLeafId).toEqual({
      protected: 'pty-0'
    })
    expect(operations.toComparablePtyId).toHaveBeenCalledTimes(3)
  })

  it('normalizes app-form binding ids onto the relay-form lease key', () => {
    // Leases store the relay-local id; sessions may hold the app-wide "ssh:<target>@@<id>" form.
    // The index key is the normalized form, so both spellings still name the same PTY.
    const operations = fixture(1)
    operations.toComparablePtyId = vi.fn(toComparableRelaySshPtyId)
    operations.state.workspaceSession!.tabsByWorktree.wt[0].ptyId = 'ssh:ssh-one@@pty-0'

    expect(clearSshRemotePtyBindingsForLeases(operations, 'ssh-one', operations.leases)).toBe(true)
    expect(operations.state.workspaceSession!.tabsByWorktree.wt[0].ptyId).toBeNull()
  })

  it('keeps a binding whose app-form id names a different SSH target', () => {
    // Relay-local ids collide across targets ("pty-0" exists on every host). Clearing ssh-one must
    // never scrub a pane still bound to a live ssh-two shell.
    const operations = fixture(1)
    operations.toComparablePtyId = vi.fn(toComparableRelaySshPtyId)
    operations.state.workspaceSession!.tabsByWorktree.wt[0].ptyId = 'ssh:ssh-two@@pty-0'

    expect(clearSshRemotePtyBindingsForLeases(operations, 'ssh-one', operations.leases)).toBe(false)
    expect(operations.state.workspaceSession!.tabsByWorktree.wt[0].ptyId).toBe('ssh:ssh-two@@pty-0')
    expect(operations.scheduleSave).not.toHaveBeenCalled()
  })

  it('keeps every binding when no lease names its PTY', () => {
    // A bucket miss must fail closed: leak a stale id rather than unbind a live pane.
    const operations = fixture(2)
    for (const lease of operations.leases) {
      lease.ptyId = `unrelated-${lease.ptyId}`
    }

    expect(clearSshRemotePtyBindingsForLeases(operations, 'ssh-one', operations.leases)).toBe(false)
    expect(operations.state.workspaceSession!.tabsByWorktree.wt.map((tab) => tab.ptyId)).toEqual([
      'pty-0',
      'pty-1'
    ])
    expect(operations.scheduleSave).not.toHaveBeenCalled()
  })

  it('does not index leases when the session holds no bindings to check', () => {
    const operations = fixture(500)
    operations.state.workspaceSession!.tabsByWorktree = {}
    operations.state.workspaceSession!.terminalLayoutsByTabId = {}

    expect(clearSshRemotePtyBindingsForLeases(operations, 'ssh-one', operations.leases)).toBe(false)
    expect(operations.toComparablePtyId).not.toHaveBeenCalled()
  })
})
