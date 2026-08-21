/**
 * STA-4593 incident: closing paired-remote tabs "worked briefly" but the tabs
 * returned seconds later and after workspace switches, on a host whose PTYs
 * outlive their tabs.
 *
 * Invariant under test: a user close committed through closeMobileSessionTab
 * stays closed — no later host publication may re-add the tab while its PTY
 * lingers connected.
 *
 * Causal boundary: shouldPreserveHeadlessMobileSessionTab preserves any
 * renderer-omitted tab whose PTY is connected && runtimeSessionOwned. Every
 * paired-created terminal is runtimeSessionOwned, and the close path clears
 * that flag only AFTER the renderer relay acknowledges — but the renderer's
 * own prune publication normally lands BEFORE the ack (retire, publish, then
 * reply). That publication runs the preserved-merge while the flag is still
 * set and the PTY exit has not fired yet, so the merge resurrects the tab the
 * renderer just retired, and nothing prunes it again until some future
 * renderer publication.
 *
 * The harness is the close-continuity pattern: a real OrcaRuntimeService with
 * injected store/notifier/pty controller. Interleavings are controlled with a
 * deferred relay ack; time is never the oracle.
 */
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-preserved-resurrection'
const WORKTREE_PATH = '/tmp/preserved-resurrection'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

const TAB_A = 'tab-reviewer-a'
const TAB_B = 'tab-main-b'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const PTY_A = 'pty-reviewer-a'
const PTY_B = 'pty-main-b'
const INC_A = '33333333-3333-4333-8333-333333333333'
const INC_B = '44444444-4444-4444-8444-444444444444'

const TAB_P = 'tab-split-parent'
// LEAF_C: the persisted session's alternative leafId for PTY_A's surface —
// renderer and headless sources can derive different leafIds for one surface.
const LEAF_C = '55555555-5555-4555-8555-555555555555'
const PTY_BY_LEAF: Record<string, string> = { [LEAF_A]: PTY_A, [LEAF_B]: PTY_B, [LEAF_C]: PTY_A }
const INC_BY_LEAF: Record<string, string> = { [LEAF_A]: INC_A, [LEAF_B]: INC_B, [LEAF_C]: INC_A }

type TabSpec = { tabId: string; leafId: string; ptyId: string }
const TAB_SPECS: Record<string, TabSpec> = {
  [TAB_A]: { tabId: TAB_A, leafId: LEAF_A, ptyId: PTY_A },
  [TAB_B]: { tabId: TAB_B, leafId: LEAF_B, ptyId: PTY_B }
}

function makeSession(tabIds: readonly string[]): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: tabIds.map((tabId, index) => ({
        id: tabId,
        ptyId: TAB_SPECS[tabId]!.ptyId,
        worktreeId: WORKTREE_ID,
        title: tabId,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: index + 1
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      tabIds.map((tabId) => [
        tabId,
        {
          root: { type: 'leaf' as const, leafId: TAB_SPECS[tabId]!.leafId },
          activeLeafId: TAB_SPECS[tabId]!.leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TAB_SPECS[tabId]!.leafId]: TAB_SPECS[tabId]!.ptyId }
        }
      ])
    ),
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey(TAB_A, LEAF_A)]: INC_A,
      [makePaneKey(TAB_B, LEAF_B)]: INC_B
    }
  }
}

function makeDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function createHarness() {
  let session = makeSession([TAB_A, TAB_B])
  const repo = {
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'preserved-resurrection',
    badgeColor: '#000000',
    addedAt: 1
  }
  const store = {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    flushOrThrow: () => {}
  }
  const relayAck = makeDeferred()
  const closeTerminal = vi.fn()
  const closeTerminalTab = vi.fn(() => relayAck.promise)
  const kill = vi.fn(() => true)
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
  runtime.setPtyController({
    write: () => true,
    kill,
    stopAndWait: vi.fn(async () => true),
    listProcesses: vi.fn(async () => [
      { id: PTY_A, incarnationId: INC_A, cwd: WORKTREE_PATH, title: 'reviewer shell' },
      { id: PTY_B, incarnationId: INC_B, cwd: WORKTREE_PATH, title: 'main shell' }
    ]),
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)

  const rendererGraph = (tabIds: readonly string[]) => ({
    tabs: tabIds.map((tabId) => ({
      tabId,
      worktreeId: WORKTREE_ID,
      title: tabId,
      activeLeafId: TAB_SPECS[tabId]!.leafId,
      layout: { type: 'leaf' as const, leafId: TAB_SPECS[tabId]!.leafId }
    })),
    leaves: tabIds.map((tabId, index) => ({
      tabId,
      worktreeId: WORKTREE_ID,
      leafId: TAB_SPECS[tabId]!.leafId,
      paneRuntimeId: index + 7,
      ptyId: TAB_SPECS[tabId]!.ptyId
    }))
  })

  const publishRendererSnapshot = (tabIds: readonly string[], snapshotVersion: number) => {
    runtime.syncWindowGraph(1, {
      ...rendererGraph(tabIds),
      mobileSessionTabs: [
        {
          worktree: WORKTREE_ID,
          publicationEpoch: 'renderer:preserved-resurrection',
          snapshotVersion,
          activeGroupId: 'group-1',
          activeTabId: tabIds.length ? `${tabIds[0]}::${TAB_SPECS[tabIds[0]!]!.leafId}` : null,
          activeTabType: tabIds.length ? ('terminal' as const) : null,
          tabs: tabIds.map((tabId, index) => ({
            type: 'terminal' as const,
            id: `${tabId}::${TAB_SPECS[tabId]!.leafId}`,
            parentTabId: tabId,
            leafId: TAB_SPECS[tabId]!.leafId,
            ptyId: TAB_SPECS[tabId]!.ptyId,
            title: tabId,
            isActive: index === 0
          }))
        }
      ]
    })
  }

  for (const spec of Object.values(TAB_SPECS)) {
    runtime.registerPty(spec.ptyId, WORKTREE_ID, null, {
      tabId: spec.tabId,
      leafId: spec.leafId,
      incarnationId: spec.tabId === TAB_A ? INC_A : INC_B
    })
    // Why: byte-identical to a paired create — ensurePtyBackedMobileSurfaceForRendererTab
    // marks every paired-created PTY runtimeSessionOwned + paired-session-owned,
    // and nothing clears either flag until close/exit.
    const record = (
      runtime as unknown as {
        ptysById: Map<string, { runtimeSessionOwned: boolean }>
      }
    ).ptysById.get(spec.ptyId)!
    record.runtimeSessionOwned = true
    ;(
      runtime as unknown as { pairedRendererSessionOwnedPtyIds: Set<string> }
    ).pairedRendererSessionOwnedPtyIds.add(spec.ptyId)
  }
  publishRendererSnapshot([TAB_A, TAB_B], 1)

  return {
    runtime,
    relayAck,
    closeTerminalTab,
    kill,
    publishRendererSnapshot,
    retirePersistedTab: (tabId: string) => {
      session = makeSession([TAB_A, TAB_B].filter((id) => id !== tabId))
    },
    isRuntimeSessionOwned: (ptyId: string) =>
      (
        runtime as unknown as { ptysById: Map<string, { runtimeSessionOwned: boolean }> }
      ).ptysById.get(ptyId)?.runtimeSessionOwned === true,
    markCreatePending: (tabId: string) => {
      ;(
        runtime as unknown as {
          pendingMobileTerminalCreatesByKey: Map<string, object>
        }
      ).pendingMobileTerminalCreatesByKey.set(`${WORKTREE_ID}::${tabId}`, {
        activate: true,
        paired: true,
        selectIfNoActiveTab: true
      })
    }
  }
}

function makeSplitLayout(leafIds: readonly string[]) {
  const root =
    leafIds.length > 1
      ? {
          type: 'split' as const,
          direction: 'vertical' as const,
          first: { type: 'leaf' as const, leafId: leafIds[0]! },
          second: { type: 'leaf' as const, leafId: leafIds[1]! },
          ratio: 0.5
        }
      : { type: 'leaf' as const, leafId: leafIds[0]! }
  return {
    root,
    activeLeafId: leafIds[0]!,
    expandedLeafId: null,
    ptyIdsByLeafId: Object.fromEntries(leafIds.map((leafId) => [leafId, PTY_BY_LEAF[leafId]!]))
  }
}

/** One parent tab split across `leafIds` — closing a leaf rewrites the layout, not the tab. */
function makeSplitSession(leafIds: readonly string[]): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_P,
          ptyId: PTY_BY_LEAF[leafIds[0]!]!,
          worktreeId: WORKTREE_ID,
          title: TAB_P,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: { [TAB_P]: makeSplitLayout(leafIds) },
    terminalPtyIncarnationsByPaneKey: Object.fromEntries(
      leafIds.map((leafId) => [makePaneKey(TAB_P, leafId), INC_BY_LEAF[leafId]!])
    )
  }
}

function createSplitHarness() {
  let session = makeSplitSession([LEAF_A, LEAF_B])
  const repo = {
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'preserved-resurrection',
    badgeColor: '#000000',
    addedAt: 1
  }
  const store = {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    flushOrThrow: () => {}
  }
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab: vi.fn(async () => {}) } as never)
  runtime.setPtyController({
    write: () => true,
    kill: vi.fn(() => true),
    stopAndWait: vi.fn(async () => true),
    listProcesses: vi.fn(async () => [
      { id: PTY_A, incarnationId: INC_A, cwd: WORKTREE_PATH, title: 'left pane' },
      { id: PTY_B, incarnationId: INC_B, cwd: WORKTREE_PATH, title: 'right pane' }
    ]),
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)

  const publishSplitSnapshot = (leafIds: readonly string[], snapshotVersion: number) => {
    const layout = makeSplitLayout(leafIds)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_P,
          worktreeId: WORKTREE_ID,
          title: TAB_P,
          activeLeafId: layout.activeLeafId,
          layout: layout.root
        }
      ],
      leaves: leafIds.map((leafId, index) => ({
        tabId: TAB_P,
        worktreeId: WORKTREE_ID,
        leafId,
        paneRuntimeId: index + 7,
        ptyId: PTY_BY_LEAF[leafId]!
      })),
      mobileSessionTabs: [
        {
          worktree: WORKTREE_ID,
          publicationEpoch: 'renderer:preserved-resurrection',
          snapshotVersion,
          activeGroupId: 'group-1',
          activeTabId: `${TAB_P}::${layout.activeLeafId}`,
          activeTabType: 'terminal' as const,
          tabs: leafIds.map((leafId, index) => ({
            type: 'terminal' as const,
            id: `${TAB_P}::${leafId}`,
            parentTabId: TAB_P,
            leafId,
            ptyId: PTY_BY_LEAF[leafId]!,
            parentLayout: layout,
            title: `${TAB_P} ${leafId}`,
            isActive: index === 0
          }))
        }
      ]
    })
  }

  for (const leafId of [LEAF_A, LEAF_B]) {
    runtime.registerPty(PTY_BY_LEAF[leafId]!, WORKTREE_ID, null, {
      tabId: TAB_P,
      leafId,
      incarnationId: INC_BY_LEAF[leafId]!
    })
    const record = (
      runtime as unknown as { ptysById: Map<string, { runtimeSessionOwned: boolean }> }
    ).ptysById.get(PTY_BY_LEAF[leafId]!)!
    record.runtimeSessionOwned = true
    ;(
      runtime as unknown as { pairedRendererSessionOwnedPtyIds: Set<string> }
    ).pairedRendererSessionOwnedPtyIds.add(PTY_BY_LEAF[leafId]!)
  }
  publishSplitSnapshot([LEAF_A, LEAF_B], 1)

  return {
    runtime,
    publishSplitSnapshot,
    isRuntimeSessionOwned: (ptyId: string) =>
      (
        runtime as unknown as { ptysById: Map<string, { runtimeSessionOwned: boolean }> }
      ).ptysById.get(ptyId)?.runtimeSessionOwned === true,
    retirePersistedLeaf: (leafId: string) => {
      session = makeSplitSession([LEAF_A, LEAF_B].filter((id) => id !== leafId))
    },
    relabelPersistedLeftLeaf: () => {
      session = makeSplitSession([LEAF_C, LEAF_B])
    }
  }
}

async function listTerminalSurfaceIds(runtime: OrcaRuntimeService): Promise<string[]> {
  const listed = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  return listed.tabs
    .filter((tab) => tab.type === 'terminal')
    .map((tab) => tab.id)
    .sort()
}

async function listParentTabIds(runtime: OrcaRuntimeService): Promise<string[]> {
  const listed = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  return [
    ...new Set(
      listed.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id)).sort()
    )
  ]
}

describe('a committed paired close stays closed while its PTY lingers', () => {
  it('control: a renderer prune that lands after the relay ack retires the tab for good', async () => {
    const harness = createHarness()

    const closing = harness.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_A, {
      reason: 'user'
    })
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalledWith(TAB_A))
    harness.retirePersistedTab(TAB_A)
    harness.relayAck.resolve()
    await expect(closing).resolves.toMatchObject({ closed: true })
    // The renderer's prune publication arrives only after the ack (and after
    // the close cleared the ownership flags).
    harness.publishRendererSnapshot([TAB_B], 2)

    expect(await listParentTabIds(harness.runtime)).toEqual([TAB_B])
  })

  it('red: the preserved-merge resurrects a pre-ack renderer prune only until the close cleans up', async () => {
    const harness = createHarness()

    const closing = harness.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_A, {
      reason: 'user'
    })
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalledWith(TAB_A))
    // Production ordering: the renderer durably retires the tab and publishes
    // the pruned graph BEFORE replying to the relay. The kill it dispatched has
    // not produced an exit yet, so the PTY record is still connected.
    harness.retirePersistedTab(TAB_A)
    harness.publishRendererSnapshot([TAB_B], 2)
    harness.relayAck.resolve()
    await expect(closing).resolves.toMatchObject({ closed: true })

    const republished = await listParentTabIds(harness.runtime)
    expect(
      republished,
      'the preserved-merge resurrected a tab whose user close was committed'
    ).toEqual([TAB_B])
  })

  it('red: a host-side close (no paired close RPC) must not be resurrected by the preserved-merge', async () => {
    const harness = createHarness()

    // The host closes the tab itself — host user gesture or `orca terminal`
    // lifecycle driven by an agent on the host. No closeMobileSessionTab runs,
    // so no post-relay cleanup exists. The renderer durably retires the tab and
    // publishes the pruned graph; the PTY it killed has not exited yet (or the
    // kill failed — WSL/Windows), so its record is still connected and still
    // carries the paired-create ownership flags.
    harness.retirePersistedTab(TAB_A)
    harness.publishRendererSnapshot([TAB_B], 2)

    const republished = await listParentTabIds(harness.runtime)
    expect(republished, 'the preserved-merge resurrected a tab the host renderer closed').toEqual([
      TAB_B
    ])
  })

  it('control: a create still in flight is not retirement — its tab and ownership survive the omission', async () => {
    const harness = createHarness()

    // The renderer's stale publication omits TAB_A while its paired create has
    // not settled: it is missing from persistence AND from the publication, the
    // exact input pattern durable retirement keys on. The pending-create mark
    // is the only discriminator, and losing it would strand the create-recovery
    // rescue: the freshly created remote tab would vanish.
    harness.markCreatePending(TAB_A)
    harness.retirePersistedTab(TAB_A)
    harness.publishRendererSnapshot([TAB_B], 2)

    expect(
      await listParentTabIds(harness.runtime),
      'a create-in-flight tab was retired by a stale publication'
    ).toEqual([TAB_B, TAB_A])
    expect(harness.isRuntimeSessionOwned(PTY_A)).toBe(true)
  })
})

describe('a durably closed split leaf stays closed while its sibling survives', () => {
  it('red: the preserved-merge must not resurrect a retired leaf of a persisted parent', async () => {
    const harness = createSplitHarness()
    expect(await listTerminalSurfaceIds(harness.runtime)).toEqual([
      `${TAB_P}::${LEAF_A}`,
      `${TAB_P}::${LEAF_B}`
    ])

    // The host closes the left pane only: the parent tab persists with the
    // surviving leaf, and the killed PTY has not exited yet (kill lag, or a
    // failed kill on WSL/Windows), so it stays connected + paired-create owned.
    harness.retirePersistedLeaf(LEAF_A)
    harness.publishSplitSnapshot([LEAF_B], 2)

    expect(
      await listTerminalSurfaceIds(harness.runtime),
      'the preserved-merge resurrected a split leaf the host renderer closed'
    ).toEqual([`${TAB_P}::${LEAF_B}`])
    expect(harness.isRuntimeSessionOwned(PTY_A)).toBe(false)
    // The surviving sibling keeps its ownership: the release must be leaf-scoped.
    expect(harness.isRuntimeSessionOwned(PTY_B)).toBe(true)
  })

  it('control: a persisted layout that still binds the PTY under a different leafId is not retirement', async () => {
    const harness = createSplitHarness()

    // The persisted session relabels PTY_A's surface to another leafId (renderer
    // and headless sources can derive different leafIds for one surface), and a
    // stale publication omits it. The still-bound PTY id is the only signal that
    // the leaf lives on; releasing on the leafId mismatch alone would retire a
    // live pane and let the merge drop it.
    harness.relabelPersistedLeftLeaf()
    harness.publishSplitSnapshot([LEAF_B], 2)

    expect(
      await listTerminalSurfaceIds(harness.runtime),
      'a live relabeled leaf was retired by a stale publication'
    ).toEqual([`${TAB_P}::${LEAF_A}`, `${TAB_P}::${LEAF_B}`])
    expect(harness.isRuntimeSessionOwned(PTY_A)).toBe(true)
    expect(harness.isRuntimeSessionOwned(PTY_B)).toBe(true)
  })
})
