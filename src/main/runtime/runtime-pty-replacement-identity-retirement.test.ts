import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const REPO_ID = 'repo-replacement'
const WORKTREE_ID = `${REPO_ID}::/tmp/replacement`
const TAB_ID = 'tab-replacement'
const LEAF_ID = '11111111-2222-4333-8444-555555555555'
const SIBLING_LEAF_ID = '99999999-2222-4333-8444-555555555555'
const PTY_ID = 'pty-replacement'
const OLD_INCARNATION = 'incarnation-predecessor'
const NEW_INCARNATION = 'incarnation-successor'
const AGENT_TITLE = 'π - replacement-test'

function makeTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: PTY_ID,
    worktreeId: WORKTREE_ID,
    title: AGENT_TITLE,
    defaultTitle: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function makeSession(tab: TerminalTab, leafIds: string[]): WorkspaceSessionState {
  return {
    tabsByWorktree: { [WORKTREE_ID]: [tab] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root:
          leafIds.length === 1
            ? { type: 'leaf', leafId: leafIds[0]! }
            : {
                type: 'split',
                direction: 'vertical',
                first: { type: 'leaf', leafId: leafIds[0]! },
                second: { type: 'leaf', leafId: leafIds[1]! }
              },
        activeLeafId: leafIds[0]!,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafIds[0]!]: PTY_ID }
      }
    }
  } as unknown as WorkspaceSessionState
}

function makeHookRow(): AgentStatusIpcPayload {
  return {
    paneKey: `${TAB_ID}:${LEAF_ID}`,
    state: 'idle',
    prompt: '',
    agentType: 'pi',
    receivedAt: Date.now(),
    stateStartedAt: Date.now()
  } as unknown as AgentStatusIpcPayload
}

function makeRuntime(
  session: WorkspaceSessionState,
  hookRows: AgentStatusIpcPayload[] = [makeHookRow()]
) {
  let current = session
  const reconcileAgentStatusForEndedProcess = vi.fn()
  const store = {
    getRepo: (id: string) => (id === REPO_ID ? { id: REPO_ID, path: '/tmp/repo' } : undefined),
    getRepos: () => [{ id: REPO_ID, path: '/tmp/repo' }],
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSession: () => current,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      current = next
    },
    getSettings: () => ({})
  }
  const runtime = new OrcaRuntimeService(store as never, undefined, {
    getAgentProviderSessionRowsForPane: () => hookRows,
    reconcileAgentStatusForEndedProcess
  })
  return { runtime, reconcileAgentStatusForEndedProcess, readSession: () => current }
}

type RetirementRuntime = OrcaRuntimeService & {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
}

function seedPublishedSurface(runtime: OrcaRuntimeService, title: string, leafId = LEAF_ID): void {
  const internals = runtime as unknown as {
    storeMobileSessionSnapshot: (worktreeId: string, snapshot: unknown) => void
  }
  internals.storeMobileSessionSnapshot(WORKTREE_ID, {
    worktree: WORKTREE_ID,
    publicationEpoch: 'headless:test',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabGroups: [],
    tabs: [
      {
        type: 'terminal',
        id: `${TAB_ID}::${leafId}`,
        parentTabId: TAB_ID,
        leafId,
        ptyId: PTY_ID,
        title,
        isActive: false
      }
    ]
  })
}

function surfaceTitle(runtime: OrcaRuntimeService, leafId = LEAF_ID): string | undefined {
  return (runtime as RetirementRuntime).mobileSessionTabsByWorktree
    .get(WORKTREE_ID)
    ?.tabs.find(
      (tab): tab is RuntimeMobileSessionTerminalTab =>
        tab.type === 'terminal' && tab.leafId === leafId
    )?.title
}

function registerIncarnation(runtime: OrcaRuntimeService, incarnationId: string): void {
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID, incarnationId })
}

function feedAgentTitle(runtime: OrcaRuntimeService, incarnationId: string): void {
  runtime.onPtyData(
    PTY_ID,
    `\x1b]0;${AGENT_TITLE}\x07`,
    1,
    20,
    false,
    undefined,
    undefined,
    incarnationId
  )
}

describe('replaced PTY identity retirement', () => {
  it('retires the predecessor surface title and hook claims on a proven replacement', () => {
    const { runtime, reconcileAgentStatusForEndedProcess, readSession } = makeRuntime(
      makeSession(makeTerminalTab(), [LEAF_ID])
    )
    registerIncarnation(runtime, OLD_INCARNATION)
    feedAgentTitle(runtime, OLD_INCARNATION)
    seedPublishedSurface(runtime, AGENT_TITLE)
    const pty = runtime['ptysById'].get(PTY_ID)!
    pty.foregroundAgent = 'pi'
    expect(pty.lastOscTitle).toBe(AGENT_TITLE)

    registerIncarnation(runtime, NEW_INCARNATION)

    expect(pty.lastOscTitle).toBeNull()
    expect(pty.lastAgentStatus).toBeNull()
    expect(pty.foregroundAgent).toBeNull()
    expect(surfaceTitle(runtime)).toBe('Terminal 1')
    expect(readSession().tabsByWorktree[WORKTREE_ID]?.[0]?.title).toBe('Terminal 1')
    expect(reconcileAgentStatusForEndedProcess).toHaveBeenCalledWith(
      expect.anything(),
      // A replacement is not a certified exit: the pane's resume identity survives.
      { preserveResumeIdentity: true }
    )
  })

  it('keeps a user-assigned title when the predecessor is retired', () => {
    const { runtime, readSession } = makeRuntime(
      makeSession(makeTerminalTab({ customTitle: 'Release shell' }), [LEAF_ID])
    )
    registerIncarnation(runtime, OLD_INCARNATION)
    feedAgentTitle(runtime, OLD_INCARNATION)
    seedPublishedSurface(runtime, AGENT_TITLE)

    registerIncarnation(runtime, NEW_INCARNATION)

    expect(surfaceTitle(runtime)).toBe('Release shell')
    expect(readSession().tabsByWorktree[WORKTREE_ID]?.[0]?.title).toBe('Release shell')
  })

  it('leaves a split tab label alone and retires only the replaced leaf surface', () => {
    const { runtime, readSession } = makeRuntime(
      makeSession(makeTerminalTab(), [LEAF_ID, SIBLING_LEAF_ID])
    )
    registerIncarnation(runtime, OLD_INCARNATION)
    feedAgentTitle(runtime, OLD_INCARNATION)
    seedPublishedSurface(runtime, AGENT_TITLE)

    registerIncarnation(runtime, NEW_INCARNATION)

    expect(surfaceTitle(runtime)).toBe('Terminal 1')
    // One persisted title covers every sibling leaf, so a surviving sibling keeps it.
    expect(readSession().tabsByWorktree[WORKTREE_ID]?.[0]?.title).toBe(AGENT_TITLE)
  })

  it('retires nothing when the same incarnation re-registers', () => {
    const { runtime, reconcileAgentStatusForEndedProcess, readSession } = makeRuntime(
      makeSession(makeTerminalTab(), [LEAF_ID])
    )
    registerIncarnation(runtime, OLD_INCARNATION)
    feedAgentTitle(runtime, OLD_INCARNATION)
    seedPublishedSurface(runtime, AGENT_TITLE)

    registerIncarnation(runtime, OLD_INCARNATION)

    expect(runtime['ptysById'].get(PTY_ID)?.lastOscTitle).toBe(AGENT_TITLE)
    expect(surfaceTitle(runtime)).toBe(AGENT_TITLE)
    expect(readSession().tabsByWorktree[WORKTREE_ID]?.[0]?.title).toBe(AGENT_TITLE)
    expect(reconcileAgentStatusForEndedProcess).not.toHaveBeenCalled()
  })

  it('treats a legacy untagged predecessor stream as no replacement proof', () => {
    const { runtime, reconcileAgentStatusForEndedProcess } = makeRuntime(
      makeSession(makeTerminalTab(), [LEAF_ID])
    )
    // A daemon that publishes no source incarnation can never establish known-old.
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })
    runtime.onPtyData(PTY_ID, `\x1b]0;${AGENT_TITLE}\x07`, 1, 20, false)
    seedPublishedSurface(runtime, AGENT_TITLE)

    registerIncarnation(runtime, NEW_INCARNATION)

    expect(surfaceTitle(runtime)).toBe(AGENT_TITLE)
    expect(reconcileAgentStatusForEndedProcess).not.toHaveBeenCalled()
  })

  it('treats a registration without an incarnation as no replacement', () => {
    const { runtime, reconcileAgentStatusForEndedProcess } = makeRuntime(
      makeSession(makeTerminalTab(), [LEAF_ID])
    )
    registerIncarnation(runtime, OLD_INCARNATION)
    feedAgentTitle(runtime, OLD_INCARNATION)
    seedPublishedSurface(runtime, AGENT_TITLE)

    // Handle rotation / a reconnect that cannot name its incarnation is not a replacement.
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })

    expect(surfaceTitle(runtime)).toBe(AGENT_TITLE)
    expect(runtime['ptysById'].get(PTY_ID)?.lastOscTitle).toBe(AGENT_TITLE)
    expect(reconcileAgentStatusForEndedProcess).not.toHaveBeenCalled()
  })

  it('clears the leaf pane title a graph reconcile would otherwise carry forward', () => {
    const { runtime } = makeRuntime(makeSession(makeTerminalTab(), [LEAF_ID]))
    registerIncarnation(runtime, OLD_INCARNATION)
    feedAgentTitle(runtime, OLD_INCARNATION)
    seedPublishedSurface(runtime, AGENT_TITLE)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: AGENT_TITLE,
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId: PTY_ID,
          paneTitle: AGENT_TITLE
        }
      ]
    })
    const leafKey = runtime['getLeafKey'](TAB_ID, LEAF_ID)
    expect(runtime['leaves'].get(leafKey)?.paneTitle).toBe(AGENT_TITLE)

    registerIncarnation(runtime, NEW_INCARNATION)

    // Reconciliation copies a leaf's pane title forward by pty id alone, so the
    // predecessor's display title must not be left on the successor's record.
    expect(runtime['leaves'].get(leafKey)?.paneTitle ?? null).toBeNull()
    expect(runtime['leaves'].get(leafKey)?.paneTitleUpdatedAt ?? null).toBeNull()
  })

  it('retires on a replacement proven by the predecessor live stream alone', () => {
    const { runtime, reconcileAgentStatusForEndedProcess } = makeRuntime(
      makeSession(makeTerminalTab(), [LEAF_ID])
    )
    // The source-tagged live stream is itself known-old proof, even with no prior binding.
    feedAgentTitle(runtime, OLD_INCARNATION)
    seedPublishedSurface(runtime, AGENT_TITLE)

    registerIncarnation(runtime, NEW_INCARNATION)

    expect(surfaceTitle(runtime)).toBe('Terminal 1')
    expect(reconcileAgentStatusForEndedProcess).toHaveBeenCalledOnce()
  })
})
