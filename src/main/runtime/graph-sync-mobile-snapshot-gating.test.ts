/** Preserve serve/browser rows through hydration while emitting real changes and suppressing no-op syncs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import * as mobileSessionTerminalProjection from './mobile-session-terminal-projection'

const WT = 'repo-1::/tmp/worktree-a'
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

function makeTerminalTab(id: string, ptyId: string | null) {
  return {
    id,
    ptyId,
    worktreeId: WT,
    title: `Terminal ${id}`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
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
  const sync = (
    mobileSessionTabs?: RuntimeMobileSessionTabsSnapshot[],
    graph: { tabs?: unknown[]; leaves?: unknown[] } = {}
  ): void => {
    runtime.syncWindowGraph(1, {
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

type RuntimeInternals = {
  offscreenBrowserBackend: unknown
  agentBrowserBridge: unknown
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
}

describe('graph-sync mobile snapshot gating', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hydrates a serve-owned terminal bound via tab.ptyId and emits it', () => {
    const { events, sync } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('serve-tab', 'serve-pty-1')] }
      })
    )

    sync([])
    vi.advanceTimersByTime(60)

    expect(events).toHaveLength(1)
    expect(events[0]?.worktree).toBe(WT)
    expect(events[0]?.tabs).toEqual([
      expect.objectContaining({ type: 'terminal', parentTabId: 'serve-tab' })
    ])
  })

  it('hydrates a serve-owned terminal bound ONLY via the layout leaf map (superset proof)', () => {
    const { events, sync } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('split-tab', null)] },
        terminalLayoutsByTabId: {
          'split-tab': {
            root: { type: 'leaf', leafId: 'leaf-a' },
            activeLeafId: 'leaf-a',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'leaf-a': 'serve-pty-2' }
          }
        }
      })
    )

    sync([])
    vi.advanceTimersByTime(60)

    expect(events).toHaveLength(1)
    expect(events[0]?.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'split-tab',
        parentLayout: expect.objectContaining({
          ptyIdsByLeafId: { 'leaf-a': 'serve-pty-2' }
        })
      })
    ])
  })

  it('skips the serve-only hydrate rebuild and emits nothing when no serve ptys and no browser backend', () => {
    const { events, sync } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('plain-tab', 'repo-1::wt@@abc')] }
      })
    )
    const buildSpy = vi.spyOn(
      mobileSessionTerminalProjection,
      'buildHeadlessMobileSessionTerminalTabs'
    )

    const snapshot = makeRendererSnapshot({ version: 1 })
    sync([structuredClone(snapshot)])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    expect(buildSpy).not.toHaveBeenCalled()

    // IPC clones lose object identity; unchanged epoch/version resends must still suppress emission.
    events.length = 0
    for (let i = 0; i < 5; i++) {
      sync([structuredClone(snapshot)])
    }
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
    expect(buildSpy).not.toHaveBeenCalled()
  })

  it('still emits when the renderer publishes a new version with identical content', () => {
    const { events, sync } = createRuntime(makeSession())

    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    events.length = 0

    sync([makeRendererSnapshot({ version: 2 })])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
  })

  it('accepts a renderer-reload epoch with a reset snapshotVersion and emits', () => {
    const { events, sync } = createRuntime(makeSession())

    sync([makeRendererSnapshot({ version: 5, epoch: 'renderer:epoch-1' })])
    vi.advanceTimersByTime(300)
    events.length = 0

    sync([makeRendererSnapshot({ version: 1, epoch: 'renderer:epoch-2', title: 'Renamed' })])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(events[0]?.publicationEpoch).toBe('renderer:epoch-2')
  })

  it('hydrates headless browser tabs when an offscreen backend exists despite zero serve terminals', () => {
    const { runtime, events, sync } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('plain-tab', 'repo-1::wt@@abc')] }
      })
    )
    const internals = runtime as unknown as RuntimeInternals
    internals.offscreenBrowserBackend = { closeTab: vi.fn() }
    internals.agentBrowserBridge = {
      tabList: vi.fn(() => ({
        tabs: [
          { browserPageId: 'page-1', index: 0, url: 'https://x.test', title: 'X', active: true }
        ]
      })),
      getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]]))
    }

    sync([])
    vi.advanceTimersByTime(60)

    expect(events).toHaveLength(1)
    expect(events[0]?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'browser', browserPageId: 'page-1' })
      ])
    )
  })

  it('fans out only the changed worktree, never the unchanged sibling (across IPC clones)', () => {
    const { events, sync } = createRuntime(makeSession())
    const snapshotB = makeRendererSnapshot({ worktree: WT_B, version: 1 })

    sync([makeRendererSnapshot({ version: 1 }), structuredClone(snapshotB)])
    vi.advanceTimersByTime(300)
    events.length = 0

    sync([makeRendererSnapshot({ version: 3, title: 'Renamed' }), structuredClone(snapshotB)])
    vi.advanceTimersByTime(60)

    expect(events).toHaveLength(1)
    expect(events[0]?.worktree).toBe(WT)
  })

  it('emits a removed frame immediately and cancels the pending coalesced notify', () => {
    const { events, sync } = createRuntime(makeSession())

    sync([makeRendererSnapshot({ version: 1 })])
    sync([])

    const removed = events.filter((event) => 'removed' in event && event.removed === true)
    expect(removed).toHaveLength(1)
    expect(removed[0]?.worktree).toBe(WT)

    events.length = 0
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
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

  it('forces an emit by the starvation cap under sustained sync churn', () => {
    const { events, sync } = createRuntime(makeSession())

    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    events.length = 0

    // Sustained 20ms churn never reaches the trailing edge; the 250ms cap must emit.
    let version = 2
    for (let elapsed = 0; elapsed <= 300; elapsed += 20) {
      sync([makeRendererSnapshot({ version: version++, title: `spin-${version}` })])
      vi.advanceTimersByTime(20)
    }
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  it('emits ready when a graph-only sync binds a restored leaf under an unchanged snapshot pair', () => {
    const { events, sync } = createRuntime(makeSession())
    // Restored layout has a PTY id before the graph leaf binds, yielding pending-handle.
    const snapshot = makeRendererSnapshot({ version: 1, ptyId: 'pty-restored' })
    const nullLeaf = {
      tabId: 'tab-1',
      worktreeId: WT,
      leafId: 'leaf-1',
      paneRuntimeId: 1,
      ptyId: null
    }
    sync([structuredClone(snapshot)], { leaves: [nullLeaf] })
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    const pendingVersion = events[0]!.snapshotVersion

    // Leaf binding changes payload even when the renderer resends the same epoch/version.
    events.length = 0
    sync([structuredClone(snapshot)], { leaves: [{ ...nullLeaf, ptyId: 'pty-restored' }] })
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs[0]).toMatchObject({
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
    expect(events[0]?.snapshotVersion).toBeGreaterThan(pendingVersion)

    events.length = 0
    sync([structuredClone(snapshot)], { leaves: [{ ...nullLeaf, ptyId: 'pty-restored' }] })
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
  })

  it('accepts a newer renderer revision after main-local touches raised the stored version', () => {
    const { runtime, events, sync } = createRuntime(makeSession())
    sync([makeRendererSnapshot({ version: 1, ptyId: 'pty-live' })])
    vi.advanceTimersByTime(300)
    events.length = 0

    // Main touches advance stored version beyond the renderer's independent counter.
    const internals = runtime as unknown as RuntimeInternals & {
      touchMobileSessionSnapshotsForPty: (ptyId: string) => void
    }
    for (let i = 0; i < 5; i++) {
      internals.touchMobileSessionSnapshotsForPty('pty-live')
    }
    vi.advanceTimersByTime(300)
    expect(internals.mobileSessionTabsByWorktree.get(WT)?.snapshotVersion).toBe(6)
    events.length = 0

    // Accept newer renderer revisions even below main's counter; emitted versions must remain monotonic.
    sync([makeRendererSnapshot({ version: 2, ptyId: 'pty-live', title: 'Renamed tab' })])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs[0]).toMatchObject({ title: 'Renamed tab' })
    expect(events[0]?.snapshotVersion).toBeGreaterThan(6)

    events.length = 0
    const emittedVersion = internals.mobileSessionTabsByWorktree.get(WT)?.snapshotVersion
    for (let i = 0; i < 3; i++) {
      sync([makeRendererSnapshot({ version: 2, ptyId: 'pty-live', title: 'Renamed tab' })])
    }
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
    expect(internals.mobileSessionTabsByWorktree.get(WT)?.snapshotVersion).toBe(emittedVersion)
    expect(internals.mobileSessionTabsByWorktree.get(WT)?.tabs[0]?.title).toBe('Renamed tab')
  })

  it('suppresses repeated unchanged syncs with a serve-owned terminal present', () => {
    const { runtime, events, sync } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('serve-tab', 'serve-pty-1')] }
      })
    )
    sync([])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    const internals = runtime as unknown as RuntimeInternals
    const stored = internals.mobileSessionTabsByWorktree.get(WT)

    events.length = 0
    for (let i = 0; i < 5; i++) {
      sync([])
    }
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
    expect(internals.mobileSessionTabsByWorktree.get(WT)).toBe(stored)
  })

  it('suppresses repeated unchanged syncs with an offscreen browser backend enabled', () => {
    const { runtime, events, sync } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('plain-tab', 'repo-1::wt@@abc')] }
      })
    )
    const internals = runtime as unknown as RuntimeInternals
    internals.offscreenBrowserBackend = { closeTab: vi.fn() }
    internals.agentBrowserBridge = {
      tabList: vi.fn(() => ({
        tabs: [
          { browserPageId: 'page-1', index: 0, url: 'https://x.test', title: 'X', active: true }
        ]
      })),
      getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]]))
    }
    sync([])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    const stored = internals.mobileSessionTabsByWorktree.get(WT)

    events.length = 0
    for (let i = 0; i < 5; i++) {
      sync([])
    }
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
    expect(internals.mobileSessionTabsByWorktree.get(WT)).toBe(stored)

    // Graph sync observes new browser tabs; same-page navigation uses the bridge notify path.
    internals.agentBrowserBridge = {
      tabList: vi.fn(() => ({
        tabs: [
          { browserPageId: 'page-1', index: 0, url: 'https://x.test', title: 'X', active: false },
          { browserPageId: 'page-2', index: 1, url: 'https://y.test', title: 'Y', active: true }
        ]
      })),
      getRegisteredTabs: vi.fn(
        () =>
          new Map([
            ['page-1', 100],
            ['page-2', 101]
          ])
      )
    }
    sync([])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'browser', browserPageId: 'page-2' })
      ])
    )
  })

  it('drops a closed renderer tab from a mixed renderer+serve snapshot while keeping the serve tab', () => {
    const { runtime, events, sync, setSession } = createRuntime(makeSession())
    const internals = runtime as unknown as RuntimeInternals

    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)

    setSession(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('serve-tab', 'serve-pty-1')] }
      })
    )
    events.length = 0
    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    const mixed = internals.mobileSessionTabsByWorktree.get(WT)
    expect(mixed?.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id))).toEqual([
      'tab-1',
      'serve-tab'
    ])

    // Drop the closed renderer tab while retaining only the still-bound serve tab.
    events.length = 0
    sync([
      {
        worktree: WT,
        publicationEpoch: 'renderer:test-epoch',
        snapshotVersion: 2,
        activeGroupId: 'group-1',
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    ])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs).toEqual([
      expect.objectContaining({ type: 'terminal', parentTabId: 'serve-tab' })
    ])

    setSession(makeSession())
    events.length = 0
    sync([
      {
        worktree: WT,
        publicationEpoch: 'renderer:test-epoch',
        snapshotVersion: 3,
        activeGroupId: 'group-1',
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    ])
    vi.advanceTimersByTime(60)
    expect(internals.mobileSessionTabsByWorktree.get(WT)?.tabs).toEqual([])
  })

  it('delivers the prune frame when the renderer omits a worktree whose serve tab is preserved', () => {
    const { events, sync } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('serve-tab', 'serve-pty-1')] }
      })
    )

    // Record the first renderer+serve merged publication.
    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    const mergedVersion = events[0]!.snapshotVersion
    expect(events[0]?.tabs.map((tab) => ('parentTabId' in tab ? tab.parentTabId : tab.id))).toEqual(
      ['serve-tab', 'tab-1']
    )

    // Omitting the renderer tab must publish a newer version with only the serve tab.
    events.length = 0
    sync([])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs).toEqual([
      expect.objectContaining({ type: 'terminal', parentTabId: 'serve-tab' })
    ])
    expect(events[0]?.snapshotVersion).toBeGreaterThan(mergedVersion)

    events.length = 0
    for (let i = 0; i < 3; i++) {
      sync([])
    }
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
  })

  it('drops a de-persisted serve tab when the renderer resends the unchanged accepted revision', () => {
    const { runtime, events, sync, setSession } = createRuntime(makeSession())
    const internals = runtime as unknown as RuntimeInternals

    setSession(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('serve-tab', 'serve-pty-1')] }
      })
    )
    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    const mergedVersion = events[0]!.snapshotVersion
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'serve-tab')
    ).toBe(true)

    // An unchanged desktop resends the same epoch/version after an unbacked serve binding vanishes;
    // re-merge and publish a newer snapshot rather than preserving the stale serve tab.
    setSession(makeSession())
    events.length = 0
    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(
      events[0]?.tabs.some((tab) => 'parentTabId' in tab && tab.parentTabId === 'serve-tab')
    ).toBe(false)
    expect(events[0]?.snapshotVersion).toBeGreaterThan(mergedVersion)
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'serve-tab')
    ).toBe(false)

    events.length = 0
    for (let i = 0; i < 3; i++) {
      sync([makeRendererSnapshot({ version: 1 })])
    }
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
  })

  it('drops a de-persisted SSH tab when the renderer resends the unchanged accepted revision', () => {
    const sshPtyId = 'ssh:conn-1@@pty-7'
    const { runtime, sync, setSession } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('ssh-tab', sshPtyId)] }
      })
    )
    const internals = runtime as unknown as RuntimeInternals & {
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (worktreeId?: string) => Set<string>
    }
    internals.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WT)

    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'ssh-tab')
    ).toBe(true)

    // After HUB-recovery grace, missing persistence must drop SSH tabs even with unchanged renderer version.
    setSession(makeSession())
    vi.advanceTimersByTime(30_001)
    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(60)
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'ssh-tab')
    ).toBe(false)
  })

  it('still preserves every tab across a renderer publication when the base snapshot is headless-built', () => {
    const { runtime, sync } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('serve-tab', 'serve-pty-1')] }
      })
    )
    const internals = runtime as unknown as RuntimeInternals

    sync([])
    vi.advanceTimersByTime(300)
    expect(
      internals.mobileSessionTabsByWorktree.get(WT)?.publicationEpoch.startsWith('headless')
    ).toBe(true)

    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(60)
    const merged = internals.mobileSessionTabsByWorktree.get(WT)
    expect(
      merged?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'serve-tab')
    ).toBe(true)
    expect(merged?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'tab-1')).toBe(
      true
    )
  })

  it('preserves a runtime-owned SSH terminal across successive renderer revisions', () => {
    const sshPtyId = 'ssh:conn-1@@pty-7'
    const { runtime, sync, setSession } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('ssh-tab', sshPtyId)] }
      })
    )
    const internals = runtime as unknown as RuntimeInternals & {
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (worktreeId?: string) => Set<string>
    }
    internals.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WT)
    expect(internals.mobileSessionTabsByWorktree.get(WT)?.tabs).toEqual([
      expect.objectContaining({ type: 'terminal', parentTabId: 'ssh-tab' })
    ])

    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    const merged = internals.mobileSessionTabsByWorktree.get(WT)
    expect(
      merged?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'ssh-tab')
    ).toBe(true)

    // Persisted app-scoped ssh:@@ bindings survive later renderer omissions too.
    sync([makeRendererSnapshot({ version: 2, title: 'Renamed' })])
    vi.advanceTimersByTime(60)
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'ssh-tab')
    ).toBe(true)

    setSession(makeSession())
    vi.advanceTimersByTime(30_001)
    sync([makeRendererSnapshot({ version: 3, title: 'Renamed again' })])
    vi.advanceTimersByTime(60)
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'ssh-tab')
    ).toBe(false)
  })

  it('retains the split-group layout across no-op syncs with a serve-owned terminal present', () => {
    const { runtime, events, sync } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('serve-tab', 'serve-pty-1')] }
      })
    )
    const internals = runtime as unknown as RuntimeInternals
    const splitLayout = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, groupId: 'group-1' },
      second: { type: 'leaf' as const, groupId: 'group-2' },
      ratio: 0.4
    }
    const makeSplitRendererSnapshot = (): RuntimeMobileSessionTabsSnapshot => ({
      worktree: WT,
      publicationEpoch: 'renderer:test-epoch',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: 'tab-1::leaf-1',
      activeTabType: 'terminal',
      tabGroups: [
        { id: 'group-1', activeTabId: 'tab-1', tabOrder: ['tab-1'] },
        { id: 'group-2', activeTabId: 'tab-2', tabOrder: ['tab-2'] }
      ],
      tabGroupLayout: structuredClone(splitLayout),
      tabs: [
        {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Terminal 1',
          isActive: true
        },
        {
          type: 'terminal',
          id: 'tab-2::leaf-1',
          parentTabId: 'tab-2',
          leafId: 'leaf-1',
          title: 'Terminal 2',
          isActive: false
        }
      ]
    })

    sync([makeSplitRendererSnapshot()])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabGroupLayout).toEqual(splitLayout)
    expect(internals.mobileSessionTabsByWorktree.get(WT)?.tabGroupLayout).toEqual(splitLayout)

    events.length = 0
    sync([makeSplitRendererSnapshot()])
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
    expect(internals.mobileSessionTabsByWorktree.get(WT)?.tabGroupLayout).toEqual(splitLayout)
  })

  it('hydrates a serve terminal that appears in the session after suppressed syncs', () => {
    const { events, sync, setSession } = createRuntime(makeSession())

    sync([])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(0)

    setSession(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('late-serve-tab', 'serve-pty-9')] }
      })
    )
    sync([])
    vi.advanceTimersByTime(60)

    expect(events).toHaveLength(1)
    expect(events[0]?.tabs).toEqual([
      expect.objectContaining({ type: 'terminal', parentTabId: 'late-serve-tab' })
    ])
  })
})
