/** Preserve serve/browser rows through hydration while emitting real changes and suppressing no-op syncs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { OrcaRuntimeService } from '../orca-runtime'

const WT = 'repo-1::/tmp/worktree-a'

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
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

function makeSession(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

function createRuntime(initialSession: WorkspaceSessionState) {
  let session = initialSession
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  })
  const events: RuntimeMobileSessionTabsResult[] = []
  const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
  const setSession = (next: WorkspaceSessionState): void => {
    session = next
  }
  const sync = async (
    mobileSessionTabs?: RuntimeMobileSessionTabsSnapshot[],
    graph: { tabs?: unknown[]; leaves?: unknown[] } = {}
  ): Promise<void> => {
    await runtime.syncWindowGraph(1, {
      tabs: (graph.tabs ?? []) as never,
      leaves: (graph.leaves ?? []) as never,
      mobileSessionTabs
    })
  }
  return { runtime, events, sync, setSession, unsubscribe }
}

function makeRendererSnapshot(args: {
  worktree?: string
  version: number
  epoch?: string
  title?: string
  ptyId?: string
}): RuntimeMobileSessionTabsSnapshot {
  const worktree = args.worktree ?? WT
  return {
    worktree,
    publicationEpoch: args.epoch ?? 'renderer:test-epoch',
    snapshotVersion: args.version,
    activeGroupId: 'group-1',
    activeTabId: 'tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1::leaf-1',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        title: args.title ?? 'Terminal 1',
        ...(args.ptyId ? { ptyId: args.ptyId } : {}),
        isActive: true
      }
    ]
  }
}

describe('graph-sync mobile snapshot gating', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drains a pending notify to existing subscribers instead of replaying it to a new one', () => {
    const { runtime, events, sync } = createRuntime(makeSession())

    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(20)
    expect(events).toHaveLength(0)

    const lateEvents: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => lateEvents.push(snapshot))
    const drainedOnSubscribe = events.length

    vi.advanceTimersByTime(500)
    // Subscribe includes armed state in its initial snapshot; do not replay it as a stale update.
    expect(lateEvents).toEqual([])
    // Drain rather than cancel so existing subscribers receive the pending change.
    expect(drainedOnSubscribe).toBe(1)
    expect(events).toHaveLength(1)
  })
})
