import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
/** STA-4593: paired-owned connected PTYs could resurrect closed tabs during preserved-merge.
 * Renderer persistence/pruned publication precedes close ack, which clears ownership only afterward.
 * Keep committed closes retired while PTYs linger; deferred acks control interleaving without timing. */
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { sessionLayoutApply } from './__fixtures__/main-layout-close-fixture'
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
// The same PTY can have different renderer/headless leaf ids.
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

function createHarness(options: { restarted?: boolean } = {}) {
  let session = makeSession([TAB_A, TAB_B])
  const repo = {
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'preserved-resurrection',
    badgeColor: '#000000',
    addedAt: 1
  }
  const store = withDurableRuntimeStore({
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    getWorkspaceSession: () => session,
    getWorkspaceSessionHostIds: () => ['local'],
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    applyLayoutCommand: sessionLayoutApply({ get: () => session, set: (next) => (session = next) }),
    flushOrThrow: () => {}
  })
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
    // Match paired-create ownership flags; they persist until close/exit.
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
  // Restart serves disk hydration until the renderer's first publication.
  if (!options.restarted) {
    publishRendererSnapshot([TAB_A, TAB_B], 1)
  }

  return {
    runtime,
    relayAck,
    closeTerminalTab,
    kill,
    publishRendererSnapshot,
    // Model committed close through main-owned layout or legacy renderer persistence.
    retirePersistedTab: async (tabId: string) => {
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await runtime.applyLayoutCommand({
          type: 'closeTabs',
          workspace: WORKTREE_ID,
          tabIds: [tabId],
          recordClose: 'user'
        })
        return
      }
      session = makeSession([TAB_A, TAB_B].filter((id) => id !== tabId))
    },
    // Mere stale omission is not a close.
    omitPersistedTab: (tabId: string) => {
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
  const store = withDurableRuntimeStore({
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    getWorkspaceSession: () => session,
    getWorkspaceSessionHostIds: () => ['local'],
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    applyLayoutCommand: sessionLayoutApply({ get: () => session, set: (next) => (session = next) }),
    flushOrThrow: () => {}
  })
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
    retirePersistedLeaf: async (leafId: string) => {
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await runtime.applyLayoutCommand({
          type: 'closePane',
          workspace: WORKTREE_ID,
          tabId: TAB_P,
          leafId
        })
        return
      }
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
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expect(closing).resolves.toMatchObject({ closed: true })
      expect(harness.closeTerminalTab).not.toHaveBeenCalled()
      harness.publishRendererSnapshot([TAB_B], 2)
      expect(await listParentTabIds(harness.runtime)).toEqual([TAB_B])
      return
    }
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalledWith(TAB_A))
    await harness.retirePersistedTab(TAB_A)
    harness.relayAck.resolve()
    await expect(closing).resolves.toMatchObject({ closed: true })
    harness.publishRendererSnapshot([TAB_B], 2)

    expect(await listParentTabIds(harness.runtime)).toEqual([TAB_B])
  })

  it('red: the preserved-merge resurrects a pre-ack renderer prune only until the close cleans up', async () => {
    const harness = createHarness()

    const closing = harness.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_A, {
      reason: 'user'
    })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expect(closing).resolves.toMatchObject({ closed: true })
      expect(harness.closeTerminalTab).not.toHaveBeenCalled()
      harness.publishRendererSnapshot([TAB_B], 2)
      expect(await listParentTabIds(harness.runtime)).toEqual([TAB_B])
      return
    }
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalledWith(TAB_A))
    // Renderer retires/publishes before relay ack; dispatched kill has not yet produced PTY exit.
    await harness.retirePersistedTab(TAB_A)
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

    // Host-side close has no mobile post-relay cleanup; PTY may stay connected after slow/failed Windows/WSL kills.
    await harness.retirePersistedTab(TAB_A)
    harness.publishRendererSnapshot([TAB_B], 2)

    const republished = await listParentTabIds(harness.runtime)
    expect(republished, 'the preserved-merge resurrected a tab the host renderer closed').toEqual([
      TAB_B
    ])
  })

  it('red: the first renderer publication after a restart must not resurrect a retired tab', async () => {
    const harness = createHarness({ restarted: true })
    expect(await listParentTabIds(harness.runtime)).toEqual([TAB_A, TAB_B].sort())

    await harness.retirePersistedTab(TAB_A)
    harness.publishRendererSnapshot([TAB_B], 1)

    expect(
      await listParentTabIds(harness.runtime),
      'the first post-restart merge resurrected a tab the host renderer closed'
    ).toEqual([TAB_B])
    expect(harness.isRuntimeSessionOwned(PTY_A)).toBe(false)
    expect(harness.isRuntimeSessionOwned(PTY_B)).toBe(true)
  })

  it('control: the first post-restart publication keeps a still-persisted tab it omits', async () => {
    const harness = createHarness({ restarted: true })
    harness.publishRendererSnapshot([TAB_B], 1)

    expect(await listParentTabIds(harness.runtime)).toEqual([TAB_A, TAB_B].sort())
    expect(harness.isRuntimeSessionOwned(PTY_A)).toBe(true)
  })

  it('control: a create still in flight is not retirement — its tab and ownership survive the omission', async () => {
    const harness = createHarness()

    // Pending create omits the tab from persistence and publication like retirement; its pending mark must preserve recovery.
    harness.markCreatePending(TAB_A)
    harness.omitPersistedTab(TAB_A)
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

    // Leaf close preserves its parent/sibling while slow or failed kills leave paired-owned PTYs connected.
    await harness.retirePersistedLeaf(LEAF_A)
    harness.publishSplitSnapshot([LEAF_B], 2)

    expect(
      await listTerminalSurfaceIds(harness.runtime),
      'the preserved-merge resurrected a split leaf the host renderer closed'
    ).toEqual([`${TAB_P}::${LEAF_B}`])
    expect(harness.isRuntimeSessionOwned(PTY_A)).toBe(false)
    expect(harness.isRuntimeSessionOwned(PTY_B)).toBe(true)
  })

  it('control: a persisted layout that still binds the PTY under a different leafId is not retirement', async () => {
    const harness = createSplitHarness()

    // Relabeling changes leafId without changing the live bound PTY; leaf mismatch alone cannot prove retirement.
    harness.relabelPersistedLeftLeaf()
    harness.publishSplitSnapshot([LEAF_B], 2)

    expect(
      await listTerminalSurfaceIds(harness.runtime),
      'a live relabeled leaf was retired by a stale publication'
    ).toEqual(
      ORCA_LAYOUT_OWNER_IS_MAIN
        ? [`${TAB_P}::${LEAF_B}`, `${TAB_P}::${LEAF_C}`]
        : [`${TAB_P}::${LEAF_A}`, `${TAB_P}::${LEAF_B}`]
    )
    expect(harness.isRuntimeSessionOwned(PTY_A)).toBe(true)
    expect(harness.isRuntimeSessionOwned(PTY_B)).toBe(true)
  })
})
