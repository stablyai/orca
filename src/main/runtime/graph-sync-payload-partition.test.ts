/**
 * The renderer withholds unchanged mobile-session snapshots from the graph
 * payload. Main must treat those worktrees as live rather than pruning them as
 * removed, and must ask for a republish of any it no longer holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncWindowGraphResult
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

const WT_A = 'repo-1::/tmp/worktree-a'
const WT_B = 'repo-1::/tmp/worktree-b'

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

function makeSession(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT_A,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

function makeTerminalTab(id: string, ptyId: string) {
  return {
    id,
    ptyId,
    worktreeId: WT_A,
    title: `Terminal ${id}`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

type RuntimeInternals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
}

function createRuntime() {
  let session = makeSession()
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  })
  const events: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
  const setSession = (next: WorkspaceSessionState): void => {
    session = next
  }
  const sync = (
    mobileSessionTabs: RuntimeMobileSessionTabsSnapshot[],
    unchangedMobileSessionWorktrees?: string[]
  ): RuntimeSyncWindowGraphResult =>
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs,
      ...(unchangedMobileSessionWorktrees ? { unchangedMobileSessionWorktrees } : {})
    })
  return { runtime, events, sync, setSession, internals: runtime as unknown as RuntimeInternals }
}

function makeSnapshot(worktree: string, version: number): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer:test-epoch',
    snapshotVersion: version,
    activeGroupId: 'group-1',
    activeTabId: 'tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1::leaf-1',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        title: `Terminal ${worktree}`,
        isActive: true
      }
    ]
  }
}

describe('graph-sync mobile payload partition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a withheld worktree alive instead of pruning it as removed', () => {
    const { events, sync, internals } = createRuntime()
    sync([makeSnapshot(WT_A, 1), makeSnapshot(WT_B, 2)])
    vi.advanceTimersByTime(300)
    const storedB = internals.mobileSessionTabsByWorktree.get(WT_B)
    expect(storedB).toBeDefined()
    events.length = 0

    // A publishes a change; B is withheld as unchanged rather than omitted.
    sync([makeSnapshot(WT_A, 3)], [WT_B])
    vi.advanceTimersByTime(300)

    expect(internals.mobileSessionTabsByWorktree.get(WT_B)).toBe(storedB)
    expect(events.filter((event) => 'removed' in event && event.removed === true)).toEqual([])
    expect(events.map((event) => event.worktree)).toEqual([WT_A])
  })

  it('still prunes a worktree the renderer omits from both lists', () => {
    const { events, sync, internals } = createRuntime()
    sync([makeSnapshot(WT_A, 1), makeSnapshot(WT_B, 2)])
    vi.advanceTimersByTime(300)
    events.length = 0

    sync([makeSnapshot(WT_A, 3)], [])
    vi.advanceTimersByTime(300)

    expect(internals.mobileSessionTabsByWorktree.has(WT_B)).toBe(false)
    const removed = events.filter((event) => 'removed' in event && event.removed === true)
    expect(removed.map((event) => event.worktree)).toEqual([WT_B])
  })

  it('asks for a republish of a withheld worktree it dropped, and accepts the resend', () => {
    const { sync, internals } = createRuntime()
    sync([makeSnapshot(WT_A, 1), makeSnapshot(WT_B, 2)])
    vi.advanceTimersByTime(300)

    // Main drops B on its own (worktree metadata removal) while the renderer
    // still believes B is delivered.
    internals.mobileSessionTabsByWorktree.delete(WT_B)

    const result = sync([], [WT_A, WT_B])
    vi.advanceTimersByTime(300)
    expect(result.mobileSessionResyncWorktrees).toEqual([WT_B])
    expect(internals.mobileSessionTabsByWorktree.has(WT_A)).toBe(true)

    // The renderer republishes B at the SAME (epoch, version) it last sent. The
    // accept gate must no longer treat that as an already-accepted no-op.
    const resend = sync([makeSnapshot(WT_B, 2)], [WT_A])
    vi.advanceTimersByTime(300)
    expect(resend.mobileSessionResyncWorktrees).toBeUndefined()
    expect(internals.mobileSessionTabsByWorktree.get(WT_B)?.tabs).toEqual([
      expect.objectContaining({ parentTabId: 'tab-1' })
    ])
  })

  it('asks for a republish when headless hydration masks a dropped renderer snapshot', () => {
    const { sync, setSession, internals } = createRuntime()
    setSession(
      makeSession({
        tabsByWorktree: { [WT_A]: [makeTerminalTab('serve-tab', 'serve-pty-1')] }
      })
    )
    sync([makeSnapshot(WT_A, 1)])
    internals.mobileSessionTabsByWorktree.delete(WT_A)

    const result = sync([], [WT_A])
    expect(result.mobileSessionResyncWorktrees).toEqual([WT_A])
    expect(internals.mobileSessionTabsByWorktree.get(WT_A)?.publicationEpoch).toMatch(
      /^headless-hydrated:/
    )

    const resend = sync([makeSnapshot(WT_A, 1)], [])
    expect(resend.mobileSessionResyncWorktrees).toBeUndefined()
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT_A)
        ?.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id))
    ).toEqual(['tab-1', 'serve-tab'])
  })

  it('requests the accepted revision again to prune a stale preserved tab', () => {
    const { sync, setSession, internals } = createRuntime()
    setSession(
      makeSession({
        tabsByWorktree: { [WT_A]: [makeTerminalTab('serve-tab', 'serve-pty-1')] }
      })
    )
    sync([makeSnapshot(WT_A, 1)])
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT_A)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'serve-tab')
    ).toBe(true)

    setSession(makeSession())
    const result = sync([], [WT_A])
    expect(result.mobileSessionResyncWorktrees).toEqual([WT_A])

    sync([makeSnapshot(WT_A, 1)], [])
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT_A)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'serve-tab')
    ).toBe(false)
  })

  it('does not request a renderer tab rejected by the retirement fence', () => {
    const { sync, setSession, internals } = createRuntime()
    setSession(
      makeSession({
        terminalTopologyRevisionByRepoId: { 'repo-1': 1 }
      })
    )

    sync([makeSnapshot(WT_A, 1)])
    expect(internals.mobileSessionTabsByWorktree.get(WT_A)?.tabs).toEqual([])

    expect(sync([], [WT_A]).mobileSessionResyncWorktrees).toBeUndefined()
    expect(sync([], [WT_A]).mobileSessionResyncWorktrees).toBeUndefined()
  })

  it('leaves the legacy full-payload contract untouched when no list is sent', () => {
    const { events, sync, internals } = createRuntime()
    sync([makeSnapshot(WT_A, 1), makeSnapshot(WT_B, 2)])
    vi.advanceTimersByTime(300)
    events.length = 0

    // No unchangedMobileSessionWorktrees field at all: omission still prunes.
    sync([makeSnapshot(WT_A, 3)])
    vi.advanceTimersByTime(300)

    expect(internals.mobileSessionTabsByWorktree.has(WT_B)).toBe(false)
    expect(
      events.filter((event) => 'removed' in event && event.removed === true).map((e) => e.worktree)
    ).toEqual([WT_B])
  })
})
