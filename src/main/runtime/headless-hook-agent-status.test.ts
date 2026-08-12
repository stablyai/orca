/**
 * Headless agent-status synchronization: on a `--serve` runtime with no renderer
 * graph sync, HTTP-hook-only agents (e.g. OpenCode) record status only in the
 * agent-hook cache. The session.tabs projection must surface that status to
 * remote/mobile clients, and a hook status change must republish — mirroring the
 * OSC 9999 path (#7970) for agents that never emit OSC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalClientTab
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/types'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { OrcaRuntimeService } from './orca-runtime'

const WT = 'repo-1::/tmp/worktree-a'
const TAB = 'tab-1'
const LEAF = '33333333-3333-4333-8333-333333333333'
const PANE_KEY = `${TAB}:${LEAF}`
const PTY = 'pty-1'

const storeBase = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [storeBase.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

function makeSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

/** A renderer mobile-session snapshot whose terminal tab carries NO graph-synced
 *  agentStatus — the headless condition where the host has no renderer to populate it. */
function makeHeadlessSnapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WT,
    publicationEpoch: 'renderer:test-epoch',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: `${TAB}::${LEAF}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${TAB}::${LEAF}`,
        parentTabId: TAB,
        leafId: LEAF,
        ptyId: PTY,
        title: 'Terminal 1',
        isActive: true
      }
    ]
  }
}

function createRuntime(hookSnapshot: () => AgentStatusIpcPayload[]) {
  const runtime = new OrcaRuntimeService(
    { ...storeBase, getWorkspaceSession: () => makeSession(), setWorkspaceSession: () => {} },
    undefined,
    { getAgentStatusSnapshot: hookSnapshot }
  )
  const events: RuntimeMobileSessionTabsResult[] = []
  const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
  const syncGraph = (): void => {
    runtime.syncWindowGraph(1, {
      tabs: [{ tabId: TAB, worktreeId: WT, title: 'Terminal', activeLeafId: LEAF, layout: null }],
      leaves: [{ tabId: TAB, worktreeId: WT, leafId: LEAF, paneRuntimeId: 1, ptyId: PTY }],
      mobileSessionTabs: [makeHeadlessSnapshot()]
    })
  }
  return { runtime, events, syncGraph, unsubscribe }
}

function firstTerminalTab(
  result: RuntimeMobileSessionTabsResult | undefined
): RuntimeMobileSessionTerminalClientTab | undefined {
  const tab = result?.tabs.find((t) => t.type === 'terminal')
  return tab?.type === 'terminal' ? tab : undefined
}

describe('headless hook-only agent status over session.tabs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('surfaces hook-reported working status when the tab has no graph-synced agentStatus', () => {
    const now = Date.now()
    const { events, syncGraph } = createRuntime(() => [
      {
        paneKey: PANE_KEY,
        worktreeId: WT,
        tabId: TAB,
        state: 'working',
        prompt: 'ship it',
        agentType: 'opencode',
        connectionId: null,
        receivedAt: now,
        stateStartedAt: now - 100
      }
    ])

    syncGraph()
    vi.advanceTimersByTime(60)

    expect(firstTerminalTab(events[0])).toMatchObject({
      agentStatus: expect.objectContaining({
        state: 'working',
        agentType: 'opencode',
        prompt: 'ship it'
      })
    })
  })

  it('does not surface stale hook status past the freshness window', () => {
    const stale = Date.now() - 31 * 60 * 1000
    const { events, syncGraph } = createRuntime(() => [
      {
        paneKey: PANE_KEY,
        worktreeId: WT,
        tabId: TAB,
        state: 'working',
        prompt: 'stale',
        agentType: 'opencode',
        connectionId: null,
        receivedAt: stale,
        stateStartedAt: stale
      }
    ])

    syncGraph()
    vi.advanceTimersByTime(60)

    expect(firstTerminalTab(events[0])?.agentStatus).toBeUndefined()
  })

  it('republishes session.tabs when touchMobileSessionSnapshotsForPty fires after a hook change', () => {
    let hookState: AgentStatusIpcPayload[] = []
    const { runtime, events, syncGraph } = createRuntime(() => hookState)

    syncGraph()
    vi.advanceTimersByTime(60)
    expect(firstTerminalTab(events[0])?.agentStatus).toBeUndefined()

    // Why: simulates the onAgentStatus listener resolving the pane PTY and republishing
    // after an HTTP hook POST lands in the agent-hook cache.
    const now = Date.now()
    hookState = [
      {
        paneKey: PANE_KEY,
        worktreeId: WT,
        tabId: TAB,
        state: 'working',
        prompt: 'now working',
        agentType: 'opencode',
        connectionId: null,
        receivedAt: now,
        stateStartedAt: now
      }
    ]
    events.length = 0
    runtime.touchMobileSessionSnapshotsForPty(PTY)
    vi.advanceTimersByTime(120)

    expect(firstTerminalTab(events[0])).toMatchObject({
      agentStatus: expect.objectContaining({ state: 'working', prompt: 'now working' })
    })
  })
})
