import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { WindowSessionRegistry } from './window-session-registry'

function makeTab(id: string, worktreeId: string) {
  return {
    id,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ptyId: `pty-${id}`
  }
}

function makeSession(
  activeTabId: string,
  options: { revision?: number; scrollbackRef?: string; worktreeId?: string } = {}
): WorkspaceSessionState {
  const worktreeId = options.worktreeId ?? 'repo-1::/worktree'
  const leafId = `leaf-${activeTabId}`
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo-1',
    activeWorktreeId: worktreeId,
    activeTabId,
    tabsByWorktree: { [worktreeId]: [makeTab(activeTabId, worktreeId)] },
    terminalLayoutsByTabId: {
      [activeTabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: `pty-${activeTabId}` },
        ...(options.scrollbackRef
          ? { scrollbackRefsByLeafId: { [leafId]: options.scrollbackRef } }
          : {})
      }
    },
    terminalTopologyRevisionByRepoId: { 'repo-1': options.revision ?? 0 }
  }
}

function makeHarness(controlWindowId = 1) {
  const sessions = new Map<string, WorkspaceSessionState>()
  const store = {
    getWorkspaceSession: vi.fn(
      (hostId?: string | null) => sessions.get(hostId ?? 'local') ?? getDefaultWorkspaceSession()
    ),
    setWorkspaceSession: vi.fn((state: WorkspaceSessionState, hostId?: string | null) => {
      sessions.set(hostId ?? 'local', structuredClone(state))
    }),
    stageWorkspaceSessionBeforeUnload: vi.fn(),
    patchWorkspaceSession: vi.fn()
  }
  const manager = {
    getControlWindow: vi.fn(() => ({ id: controlWindowId }))
  }
  return { manager, sessions, store }
}

describe('WindowSessionRegistry', () => {
  it('unions terminal membership while the control window owns active/layout conflicts', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    const control = makeSession('tab-control', { revision: 2 })
    const secondary = makeSession('tab-secondary', { revision: 7 })
    control.activeTabIdByWorktree = { [control.activeWorktreeId!]: 'tab-control' }
    secondary.activeTabIdByWorktree = { [secondary.activeWorktreeId!]: 'tab-secondary' }
    control.tabGroups = {
      [control.activeWorktreeId!]: [
        {
          id: 'shared-group',
          worktreeId: control.activeWorktreeId!,
          activeTabId: 'tab-control',
          tabOrder: ['tab-control']
        }
      ]
    }
    secondary.tabGroups = {
      [secondary.activeWorktreeId!]: [
        {
          id: 'shared-group',
          worktreeId: secondary.activeWorktreeId!,
          activeTabId: 'tab-secondary',
          tabOrder: ['tab-secondary']
        }
      ]
    }
    registry.set(1, control, 'local')
    registry.set(2, secondary, 'local')

    const merged = registry.mergeHost('local')

    expect(merged.activeTabId).toBe('tab-control')
    expect(merged.activeTabIdByWorktree?.['repo-1::/worktree']).toBe('tab-control')
    expect(merged.tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)).toEqual([
      'tab-control',
      'tab-secondary'
    ])
    expect(Object.keys(merged.terminalLayoutsByTabId)).toEqual(['tab-control', 'tab-secondary'])
    expect(merged.tabGroups?.['repo-1::/worktree'][0]).toMatchObject({
      activeTabId: 'tab-control',
      tabOrder: ['tab-control', 'tab-secondary']
    })
    expect(merged.terminalTopologyRevisionByRepoId).toEqual({ 'repo-1': 7 })
  })

  it('keeps local and SSH records in separate host partitions', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('local-tab'), 'local')
    registry.set(1, makeSession('ssh-tab'), 'ssh:server-1')

    expect(registry.get(1, 'local').activeTabId).toBe('local-tab')
    expect(registry.get(1, 'ssh:server-1').activeTabId).toBe('ssh-tab')
    expect(registry.mergeHost('local').tabsByWorktree['repo-1::/worktree'][0]?.id).toBe('local-tab')
    expect(registry.mergeHost('ssh:server-1').tabsByWorktree['repo-1::/worktree'][0]?.id).toBe(
      'ssh-tab'
    )
  })

  it('persists the target scrollback reference before the source record drops it', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    const source = makeSession('tab-1', { scrollbackRef: 'scrollback/ref-1' })
    registry.set(1, source)
    registry.set(2, source)
    registry.set(1, getDefaultWorkspaceSession())

    const writes = store.setWorkspaceSession.mock.calls.map(([state]) => state)
    const targetPrepared = writes.at(-2) as WorkspaceSessionState
    const sourceRemoved = writes.at(-1) as WorkspaceSessionState
    expect(
      Object.values(targetPrepared.terminalLayoutsByTabId['tab-1']?.scrollbackRefsByLeafId ?? {})
    ).toContain('scrollback/ref-1')
    expect(
      Object.values(sourceRemoved.terminalLayoutsByTabId['tab-1']?.scrollbackRefsByLeafId ?? {})
    ).toContain('scrollback/ref-1')
  })

  it('patches one window record then writes the merged host session', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('tab-1'))

    registry.patch(1, { activeTabId: 'tab-updated' })

    expect(registry.get(1).activeTabId).toBe('tab-updated')
    expect(store.setWorkspaceSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeTabId: 'tab-updated' }),
      'local'
    )
  })

  it('retires closed windows but preserves their last record after quit freeze', () => {
    const { manager, store } = makeHarness(2)
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('tab-1'))
    registry.set(2, makeSession('tab-2'))
    registry.retire(1, 'user-close')
    expect(registry.mergeHost().tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)).toEqual([
      'tab-2'
    ])

    registry.set(1, makeSession('tab-1'))
    registry.freezeForQuit()
    registry.retire(1, 'user-close')
    expect(registry.mergeHost().tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)).toEqual([
      'tab-2',
      'tab-1'
    ])

    registry.resumeAfterQuitAbort()
    registry.retire(1, 'user-close')
    expect(registry.mergeHost().tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)).toEqual([
      'tab-2'
    ])
  })

  it('stages only the merged host snapshot during beforeunload', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('tab-1'))
    registry.set(2, makeSession('tab-2'))

    registry.stageBeforeUnload(2, [{ state: makeSession('tab-2') }])

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledOnce()
    const [staged, hostId] = store.stageWorkspaceSessionBeforeUnload.mock.calls[0]
    expect(hostId).toBe('local')
    expect(staged.tabsByWorktree['repo-1::/worktree'].map((tab: { id: string }) => tab.id)).toEqual(
      ['tab-1', 'tab-2']
    )
  })
})
