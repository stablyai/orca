import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { hasClosedTerminalTabRecord } from '../../shared/closed-terminal-tab-tombstones'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import { OrcaRuntimeService } from './orca-runtime'
import { terminalSurfaceCloseMutation } from './terminal-surface-close'
import { capturePersistedTerminalTabCopy } from './workspace-session-terminal-tab-retirement-identity'

const REPO = {
  id: 'repo',
  path: '/worktree',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
} as const
const WORKTREE_ID = 'repo::/worktree'
const LEAF = '11111111-1111-4111-8111-111111111111'
const SPILL_HOST_ID: ExecutionHostId = 'runtime:env-1'

function terminalTab(id: string, ptyId: string) {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function sessionWithTab(id: string, ptyId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WORKTREE_ID]: [terminalTab(id, ptyId)] },
    terminalLayoutsByTabId: {
      [id]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: ptyId }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [`${id}:${LEAF}`]: `${id}-incarnation` }
  }
}

function harness(sessions: Map<ExecutionHostId, WorkspaceSessionState>) {
  const kill = vi.fn(() => true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This runtime fixture supplies the persistence methods exercised by the test.
  const store = withDurableRuntimeStore({
    getRepos: () => [REPO],
    getRepo: (id: string) => (id === REPO.id ? REPO : undefined),
    getWorktreeMeta: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorkspaceSessionHostIds: () => [...sessions.keys()],
    getWorkspaceSession: (hostId?: ExecutionHostId) =>
      sessions.get(hostId ?? LOCAL_EXECUTION_HOST_ID) ?? getDefaultWorkspaceSession(),
    setWorkspaceSession: (session: WorkspaceSessionState, hostId?: ExecutionHostId) =>
      sessions.set(hostId ?? LOCAL_EXECUTION_HOST_ID, session),
    flushOrThrow: vi.fn()
  }) as never
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: () => true,
    kill,
    getForegroundProcess: async () => null,
    listProcesses: async () => [{ id: 'target-pty', cwd: REPO.path, title: 'Terminal' }]
  })
  // The published snapshot lists both partitions' tabs, as the Web UI sees them.
  const tabs = [...sessions.values()].flatMap((session) =>
    buildHeadlessMobileSessionTerminalTabs(
      WORKTREE_ID,
      session.tabsByWorktree[WORKTREE_ID] ?? [],
      session
    )
  )
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: WORKTREE_ID,
    publicationEpoch: 'headless',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: tabs[0]?.id ?? null,
    activeTabType: 'terminal',
    tabs: tabs.filter((tab, index) => tabs.findIndex((other) => other.id === tab.id) === index)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the published snapshot map is protected; seeding it stands in for a prior publication.
  const internals = runtime as unknown as {
    mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  }
  internals.mobileSessionTabsByWorktree.set(WORKTREE_ID, snapshot)
  return { runtime, kill }
}

describe('terminal close across local and runtime session partitions (#18202)', () => {
  it('closes a tab persisted only in a runtime spill partition', async () => {
    const local = sessionWithTab('unrelated', 'unrelated-pty')
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [LOCAL_EXECUTION_HOST_ID, local],
      [SPILL_HOST_ID, sessionWithTab('target', 'target-pty')]
    ])
    const { runtime, kill } = harness(sessions)
    runtime.registerPty('target-pty', WORKTREE_ID, null, {
      tabId: 'target',
      leafId: LEAF,
      incarnationId: 'target-incarnation'
    })

    const terminal = (await runtime.listTerminals()).terminals.find(
      (candidate) => candidate.tabId === 'target'
    )!
    await expect(runtime.closeTerminalTab(terminal.handle)).resolves.toMatchObject({
      tabId: 'target'
    })

    const spill = sessions.get(SPILL_HOST_ID)!
    expect(spill.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(spill.terminalLayoutsByTabId.target).toBeUndefined()
    expect(hasClosedTerminalTabRecord(spill.closedTerminalTabTombstonesByTabId, 'target')).toBe(
      true
    )
    expect(kill).toHaveBeenCalledWith('target-pty')
    // The unrelated tab and its partition are untouched.
    expect(sessions.get(LOCAL_EXECUTION_HOST_ID)).toBe(local)
  })

  it('closes and records every copy when legacy reattach left one in two partitions', async () => {
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [LOCAL_EXECUTION_HOST_ID, sessionWithTab('unrelated', 'unrelated-pty')],
      [SPILL_HOST_ID, sessionWithTab('target', 'target-pty')],
      ['runtime:env-0', sessionWithTab('target', 'target-pty')]
    ])
    const { runtime } = harness(sessions)
    runtime.registerPty('target-pty', WORKTREE_ID, null, {
      tabId: 'target',
      leafId: LEAF,
      incarnationId: 'target-incarnation'
    })

    const terminal = (await runtime.listTerminals()).terminals.find(
      (candidate) => candidate.tabId === 'target'
    )!
    await expect(runtime.closeTerminalTab(terminal.handle)).resolves.toMatchObject({
      tabId: 'target'
    })

    for (const hostId of [SPILL_HOST_ID, 'runtime:env-0'] as const) {
      const session = sessions.get(hostId)!
      expect(session.tabsByWorktree[WORKTREE_ID]).toEqual([])
      expect(hasClosedTerminalTabRecord(session.closedTerminalTabTombstonesByTabId, 'target')).toBe(
        true
      )
    }
    expect(sessions.get(LOCAL_EXECUTION_HOST_ID)?.tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('refuses when a second copy was rebound after the close was asked', () => {
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [SPILL_HOST_ID, sessionWithTab('target', 'target-pty')],
      ['runtime:env-0', sessionWithTab('target', 'target-pty')]
    ])
    const requestedHolders = new Map(
      [...sessions].map(([hostId, session]) => [
        hostId,
        capturePersistedTerminalTabCopy(session, WORKTREE_ID, 'target')
      ])
    )
    // In place, as the binding writer rebinds a session it holds.
    const second = sessions.get('runtime:env-0')!
    second.terminalLayoutsByTabId.target!.ptyIdsByLeafId = { [LEAF]: 'replacement-pty' }
    second.terminalPtyIncarnationsByPaneKey = { [`target:${LEAF}`]: 'replacement-incarnation' }
    const setSession = vi.fn()
    const onClosed = vi.fn()

    const mutation = terminalSurfaceCloseMutation({
      worktreeId: WORKTREE_ID,
      target: { kind: 'tab', tabId: 'target' },
      options: {},
      requestedSession: sessions.get(SPILL_HOST_ID),
      requestedHolders,
      ownerMatches: () => true,
      hostIds: () => [...sessions.keys()],
      getSession: (hostId) => sessions.get(hostId),
      setSession,
      onClosed
    })()

    expect(mutation).toEqual({
      value: new Error('terminal_pane_owner_changed'),
      persist: false
    })
    expect(setSession).not.toHaveBeenCalled()
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('keeps the pin guard of the partition that holds the tab', async () => {
    const spill = sessionWithTab('target', 'target-pty')
    spill.tabsByWorktree[WORKTREE_ID] = [{ ...terminalTab('target', 'target-pty'), isPinned: true }]
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [LOCAL_EXECUTION_HOST_ID, sessionWithTab('unrelated', 'unrelated-pty')],
      [SPILL_HOST_ID, spill]
    ])
    const { runtime, kill } = harness(sessions)

    await expect(runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, 'target')).rejects.toThrow(
      'terminal_tab_pinned'
    )
    expect(sessions.get(SPILL_HOST_ID)).toBe(spill)
    expect(kill).not.toHaveBeenCalled()
  })
})
