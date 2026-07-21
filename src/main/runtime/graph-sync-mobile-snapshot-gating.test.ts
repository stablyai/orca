/**
 * Graph-sync mobile snapshot gating: the serve-only hydrate fast-path must
 * never hide a serve-owned terminal or a headless browser tab, and the
 * changed-worktree coalesced fanout must emit every real change while
 * suppressing no-op syncs entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

// Freshness predicate of shouldApplyWebSessionTabsSnapshot in
// src/renderer/src/runtime/web-session-tabs-sync.ts, copied as a literal
// because a main-process test must not import a renderer module: a same-epoch
// frame whose version is not strictly newer is dropped by web clients.
function makeWebClientFreshnessGate(): (frame: RuntimeMobileSessionTabsResult) => boolean {
  const latestByWorktree = new Map<string, { publicationEpoch: string; snapshotVersion: number }>()
  return (frame) => {
    const current = latestByWorktree.get(frame.worktree)
    if (
      current &&
      current.publicationEpoch === frame.publicationEpoch &&
      frame.snapshotVersion <= current.snapshotVersion
    ) {
      return false
    }
    latestByWorktree.set(frame.worktree, {
      publicationEpoch: frame.publicationEpoch,
      snapshotVersion: frame.snapshotVersion
    })
    return true
  }
}

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
  buildHeadlessMobileSessionTerminalTabs: (...args: unknown[]) => unknown[]
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
    const { runtime, events, sync } = createRuntime(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('plain-tab', 'repo-1::wt@@abc')] }
      })
    )
    const buildSpy = vi.spyOn(
      runtime as unknown as RuntimeInternals,
      'buildHeadlessMobileSessionTerminalTabs'
    )

    const snapshot = makeRendererSnapshot({ version: 1 })
    sync([structuredClone(snapshot)])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    expect(buildSpy).not.toHaveBeenCalled()

    // Re-sync with fresh IPC-style structured clones of the same publication
    // (same epoch + version = the renderer's unchanged-content resend): zero
    // emits, even though object identity never survives IPC.
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

    // Byte-identical content, but a fresh version: a higher version is the
    // renderer saying "this worktree changed", so it must emit.
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

    // Worktree A republishes with a new version; unchanged B arrives as a fresh
    // structured clone with the same (epoch, version) pair, exactly as the
    // renderer's per-worktree snapshot cache produces over IPC.
    sync([makeRendererSnapshot({ version: 3, title: 'Renamed' }), structuredClone(snapshotB)])
    vi.advanceTimersByTime(60)

    expect(events).toHaveLength(1)
    expect(events[0]?.worktree).toBe(WT)
  })

  it('emits a removed frame immediately and cancels the pending coalesced notify', () => {
    const { events, sync } = createRuntime(makeSession())

    sync([makeRendererSnapshot({ version: 1 })])
    // Pending coalesced notify exists (no timer advance yet). Removing the
    // worktree must emit the removed frame NOW and cancel the pending notify.
    sync([])

    const removed = events.filter((event) => 'removed' in event && event.removed === true)
    expect(removed).toHaveLength(1)
    expect(removed[0]?.worktree).toBe(WT)

    events.length = 0
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)
  })

  it('forces an emit by the starvation cap under sustained sync churn', () => {
    const { events, sync } = createRuntime(makeSession())

    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    events.length = 0

    // Re-schedule every 20ms: the 50ms trailing edge never settles, so the
    // 250ms cap must force the emit (the schedule at t>=250 fires inline).
    let version = 2
    for (let elapsed = 0; elapsed <= 300; elapsed += 20) {
      sync([makeRendererSnapshot({ version: version++, title: `spin-${version}` })])
      vi.advanceTimersByTime(20)
    }
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  it('emits ready when a graph-only sync binds a restored leaf under an unchanged snapshot pair', () => {
    const { events, sync } = createRuntime(makeSession())
    const webClientAccepts = makeWebClientFreshnessGate()
    // Renderer restore: the saved layout ptyId is in the snapshot, but the
    // graph leaf has not re-bound yet (null ptyId) — client sees pending-handle.
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
    // The web client applies the pending frame and records its (epoch, version).
    expect(webClientAccepts(events[0]!)).toBe(true)

    // A later graph-only sync binds the leaf while the renderer resends the
    // exact same (epoch, version) pair. The payload is a function of leaf state
    // too, so the subscriber must receive ready + a terminal handle.
    events.length = 0
    sync([structuredClone(snapshot)], { leaves: [{ ...nullLeaf, ptyId: 'pty-restored' }] })
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs[0]).toMatchObject({
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
    // Why: the raw listener receiving the frame is not enough — the web
    // freshness gate drops same-epoch versions that aren't strictly newer, so
    // the ready frame must carry a bumped version to actually reach the client.
    expect(webClientAccepts(events[0]!)).toBe(true)

    // Once bound, further byte-identical no-op syncs stay fully suppressed.
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

    // Several OSC/status chunks touch the stored snapshot: version 1 → 6,
    // while the renderer's counter is still at 1.
    const internals = runtime as unknown as RuntimeInternals & {
      touchMobileSessionSnapshotsForPty: (ptyId: string) => void
    }
    for (let i = 0; i < 5; i++) {
      internals.touchMobileSessionSnapshotsForPty('pty-live')
    }
    vi.advanceTimersByTime(300)
    expect(internals.mobileSessionTabsByWorktree.get(WT)?.snapshotVersion).toBe(6)
    events.length = 0

    // The renderer's next real change publishes version 2 — lower than main's 6.
    // It must merge (renderer ordering, not stored-version ordering) and the
    // emitted version must stay strictly monotonic so clients don't drop it.
    sync([makeRendererSnapshot({ version: 2, ptyId: 'pty-live', title: 'Renamed tab' })])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs[0]).toMatchObject({ title: 'Renamed tab' })
    expect(events[0]?.snapshotVersion).toBeGreaterThan(6)

    // Byte-identical graph-sync resends of that revision are no-op suppressed
    // and never resurrect the pre-rename content.
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

    // Byte-identical re-syncs: the serve-only hydrate rebuilds the projection
    // but must retain the existing snapshot object/epoch/version, so the
    // identity-based no-op gating emits nothing.
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

    // A real browser change (a newly opened page) must still emit. Same-page
    // navigation is delivered via the browser-bridge notify path, not graph
    // sync, so a new tab is the graph-sync-visible browser change.
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

    // Renderer publishes desktop tab A with no serve terminals anywhere.
    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)

    // A serve-owned terminal appears in the persisted session; the serve-only
    // hydrate merges it into the stored RENDERER publication (mixed snapshot).
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

    // Desktop closes tab A: the next renderer publication omits it. The merge
    // must NOT resurrect A from the mixed snapshot, but the serve tab (not
    // renderer-owned) must survive.
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

    // The serve binding itself disappears from persistence (and no live PTY
    // backs it): the next renderer publication must stop preserving it too.
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
    const webClientAccepts = makeWebClientFreshnessGate()

    // Phone accepts the renderer+serve merged frame.
    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    expect(webClientAccepts(events[0]!)).toBe(true)
    expect(events[0]?.tabs.map((tab) => ('parentTabId' in tab ? tab.parentTabId : tab.id))).toEqual(
      ['tab-1', 'serve-tab']
    )

    // Desktop closes the renderer tab, so the next graph omits the worktree
    // while the serve binding persists. Preservation prunes the renderer tab,
    // but the preserved epoch hashes only the unchanged serve tab — without a
    // fresh snapshotVersion the phone's same-epoch freshness gate drops the
    // prune frame and keeps the closed tab forever.
    events.length = 0
    sync([])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs).toEqual([
      expect.objectContaining({ type: 'terminal', parentTabId: 'serve-tab' })
    ])
    expect(webClientAccepts(events[0]!)).toBe(true)

    // Recomputing the preservation on further omitted syncs is a genuine
    // no-op: the preservedIsNoOp identity gate keeps the entry, zero fanout.
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
    const webClientAccepts = makeWebClientFreshnessGate()

    // Renderer publishes (epoch, version 1) while a serve binding exists; the
    // serve-only hydrate merges the serve tab and version 1 becomes accepted.
    setSession(
      makeSession({
        tabsByWorktree: { [WT]: [makeTerminalTab('serve-tab', 'serve-pty-1')] }
      })
    )
    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    expect(webClientAccepts(events[0]!)).toBe(true)
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'serve-tab')
    ).toBe(true)

    // The serve binding disappears from persistence (no live PTY backs it)
    // while desktop tabs are unchanged, so the renderer correctly resends the
    // SAME (epoch, version 1). The accepted-revision no-op gate must not keep
    // the stale preserved serve tab published: the resend must re-merge, drop
    // the tab, and reach clients past their same-epoch freshness gate.
    setSession(makeSession())
    events.length = 0
    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(60)
    expect(events).toHaveLength(1)
    expect(
      events[0]?.tabs.some((tab) => 'parentTabId' in tab && tab.parentTabId === 'serve-tab')
    ).toBe(false)
    expect(webClientAccepts(events[0]!)).toBe(true)
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'serve-tab')
    ).toBe(false)

    // Further byte-identical resends of the accepted revision stay suppressed.
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

    // Renderer attaches: the SSH tab merges into the accepted renderer revision.
    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'ssh-tab')
    ).toBe(true)

    // The persisted SSH binding is removed with no renderer-visible change, so
    // the renderer resends the unchanged version 1 — the tab must still drop.
    setSession(makeSession())
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

    // Headless-built snapshot (serve hydrate, no renderer publication yet).
    sync([])
    vi.advanceTimersByTime(300)
    expect(
      internals.mobileSessionTabsByWorktree.get(WT)?.publicationEpoch.startsWith('headless')
    ).toBe(true)

    // A renderer attaches and publishes an unrelated tab: the headless-built
    // tab must be preserved into the merged renderer snapshot (broad rule).
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
    // Full headless hydrate (SSH tabs never come from the serve-only path)
    // builds the SSH tab into a headless-built snapshot.
    internals.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WT)
    expect(internals.mobileSessionTabsByWorktree.get(WT)?.tabs).toEqual([
      expect.objectContaining({ type: 'terminal', parentTabId: 'ssh-tab' })
    ])

    // A renderer attaches and publishes an unrelated tab: the SSH tab is merged
    // into the renderer epoch (broad headless-built preservation).
    sync([makeRendererSnapshot({ version: 1 })])
    vi.advanceTimersByTime(300)
    const merged = internals.mobileSessionTabsByWorktree.get(WT)
    expect(
      merged?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'ssh-tab')
    ).toBe(true)

    // A newer renderer revision still omits the still-runtime-owned SSH tab.
    // Its binding remains persisted, so it must remain published — this is the
    // regression: serve-only preservation dropped app-scoped ssh:@@ bindings.
    sync([makeRendererSnapshot({ version: 2, title: 'Renamed' })])
    vi.advanceTimersByTime(60)
    expect(
      internals.mobileSessionTabsByWorktree
        .get(WT)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'ssh-tab')
    ).toBe(true)

    // Once the SSH binding disappears from persistence (and no live PTY backs
    // it), the next renderer revision must stop preserving it.
    setSession(makeSession())
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

    // Renderer publishes a two-group split while a serve binding exists; the
    // merged snapshot must carry the renderer's split layout.
    sync([makeSplitRendererSnapshot()])
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabGroupLayout).toEqual(splitLayout)
    expect(internals.mobileSessionTabsByWorktree.get(WT)?.tabGroupLayout).toEqual(splitLayout)

    // A second identical renderer pair: the serve-only hydrate rebuild runs
    // (serve PTY present) and must carry the stored split layout forward, so
    // the sync is a full no-op — stored layout unchanged, zero fanout.
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
