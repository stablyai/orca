import { describe, expect, it, vi } from 'vitest'
import { SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { TerminalExitRecord } from '../../shared/terminal-surface-exit'
import { dropRetirementProofsForLiveSurfaces } from '../../shared/terminal-retirement-proof-ledger'
import { makePaneKey } from '../../shared/stable-pane-id'
import { resolveStablePaneOwner } from '../ipc/pty/pane/stable-owner'
import { projectSessionTabsForClient } from './rpc/methods/session-tabs-inventory'

const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  store,
  TEST_WORKTREE_ID,
  HEADLESS_LEAF_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')
const { makePendingAgentTabActivationRuntime } =
  await import('./orca-runtime-test-scenario-builders.spec')

type Runtime = InstanceType<typeof OrcaRuntimeService>

const TAB_ID = 'desk-tab'
const SIBLING_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const DEAD_PTY_ID = 'pty-dead'

function exitRecord(overrides: Partial<TerminalExitRecord> = {}): TerminalExitRecord {
  return {
    worktreeId: TEST_WORKTREE_ID,
    leafId: HEADLESS_LEAF_ID,
    ptyId: DEAD_PTY_ID,
    incarnationId: 'inc-dead',
    terminal: 'term_dead',
    exitCode: 3,
    cause: { kind: 'exited', exitCode: 3 },
    exitedAt: 1_700_000_000_000,
    ...overrides
  }
}

function rendererSnapshot(
  leaves: { tabId: string; leafId: string; ptyId?: string }[]
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'renderer-exit-record',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: `${leaves[0]!.tabId}::${leaves[0]!.leafId}`,
    activeTabType: 'terminal',
    tabs: leaves.map((leaf, index) => ({
      type: 'terminal' as const,
      id: `${leaf.tabId}::${leaf.leafId}`,
      parentTabId: leaf.tabId,
      leafId: leaf.leafId,
      ...(leaf.ptyId ? { ptyId: leaf.ptyId } : {}),
      title: 'Terminal',
      isActive: index === 0
    }))
  }
}

/** A persisted session holding `host-tab`, its one leaf bound to `ptyId` when given. */
function sessionStoreWithHostTab(ptyId?: string, shellOverride?: string) {
  return makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId: ptyId ?? null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ...(shellOverride ? { shellOverride } : {})
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
      }
    })
  )
}

function makeRendererRuntime(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  runtimeStore: typeof store = store
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture stores implement every RuntimeStore member these runtime paths call; the shared fixtures are partial by design.
  const runtime = new OrcaRuntimeService(runtimeStore as never)
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-runtime-spawn' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  const notifier = {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    revealTerminalSession: vi.fn(async (_worktreeId: string, opts: { tabId?: string }) => ({
      tabId: opts.tabId ?? 'revealed-tab',
      title: null
    })),
    terminalExitRecordsChanged: vi.fn()
  }
  runtime.setNotifier(notifier)
  runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [snapshot] })
  return { runtime, spawn, notifier }
}

/** The desktop renderer's graph holding every terminal leaf of `snapshot`. */
function publishDesktopGraph(runtime: Runtime, snapshot: RuntimeMobileSessionTabsSnapshot): void {
  const leaves = snapshot.tabs.flatMap((tab) => (tab.type === 'terminal' ? [tab] : []))
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [...new Set(leaves.map((leaf) => leaf.parentTabId))].map((tabId) => ({
      tabId,
      worktreeId: TEST_WORKTREE_ID,
      title: 'Terminal',
      activeLeafId: leaves.find((leaf) => leaf.parentTabId === tabId)!.leafId,
      layout: null
    })),
    leaves: leaves.map((leaf, index) => ({
      tabId: leaf.parentTabId,
      worktreeId: TEST_WORKTREE_ID,
      leafId: leaf.leafId,
      paneRuntimeId: index + 1,
      ptyId: leaf.ptyId ?? null,
      paneTitle: null
    })),
    mobileSessionTabs: [snapshot]
  })
}

async function listForClient(
  runtime: Runtime,
  capabilities: string[]
): Promise<RuntimeMobileSessionTabsResult> {
  return projectSessionTabsForClient(
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`),
    'runtime',
    capabilities,
    false
  )
}

describe('terminal exit records', () => {
  it('publishes a kept leaf as exited only to a client that negotiated the capability', async () => {
    const { runtime, notifier } = makeRendererRuntime(
      rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    )
    runtime.terminalExitRecords.record(exitRecord())

    expect(notifier.terminalExitRecordsChanged).toHaveBeenLastCalledWith([exitRecord()])
    const capable = await listForClient(runtime, [
      SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY
    ])
    expect(capable.tabs).toEqual([
      expect.objectContaining({
        leafId: HEADLESS_LEAF_ID,
        status: 'pending-handle',
        exited: {
          exitCode: 3,
          cause: { kind: 'exited', exitCode: 3 },
          exitedAt: 1_700_000_000_000
        }
      })
    ])
    // Why: a dead process's ids published to clients would become a permanent wire contract.
    expect(JSON.stringify(capable)).not.toMatch(/pty-dead|inc-dead|term_dead/)

    // Why: an older client reads a handle-less leaf as a terminal still starting and waits forever.
    const old = await listForClient(runtime, [])
    expect(old.tabs).toEqual([])
    expect(old.snapshotVersion).toBe(capable.snapshotVersion)
    expect(old.retiredTerminalSurfaces).toEqual([
      {
        parentTabId: TAB_ID,
        leafId: HEADLESS_LEAF_ID,
        ptyId: DEAD_PTY_ID,
        terminal: 'term_dead',
        incarnationId: 'inc-dead'
      }
    ])
  })

  it('retires only the exited leaf of a split for an older client', async () => {
    const { runtime } = makeRendererRuntime(
      rendererSnapshot([
        { tabId: TAB_ID, leafId: HEADLESS_LEAF_ID },
        { tabId: TAB_ID, leafId: SIBLING_LEAF_ID, ptyId: 'pty-sibling' }
      ])
    )
    runtime.terminalExitRecords.record(exitRecord())

    const old = await listForClient(runtime, [])

    expect(old.tabs.map((tab) => (tab.type === 'terminal' ? tab.leafId : tab.id))).toEqual([
      SIBLING_LEAF_ID
    ])
  })

  it('never leaves an older client a handle-less leaf, even one still carrying its old binding', async () => {
    const { runtime } = makeRendererRuntime(
      rendererSnapshot([
        { tabId: TAB_ID, leafId: HEADLESS_LEAF_ID, ptyId: 'pty-stale-binding' },
        { tabId: TAB_ID, leafId: SIBLING_LEAF_ID, ptyId: 'pty-sibling' }
      ])
    )
    runtime.terminalExitRecords.record(exitRecord())

    const old = await listForClient(runtime, [])

    expect(old.tabs.map((tab) => (tab.type === 'terminal' ? tab.leafId : tab.id))).toEqual([
      SIBLING_LEAF_ID
    ])
  })

  it('keeps the record with the leaf when the pane moves to another tab', async () => {
    const { runtime } = makeRendererRuntime(
      rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    )
    runtime.terminalExitRecords.record(exitRecord())
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          ...rendererSnapshot([{ tabId: 'moved-tab', leafId: HEADLESS_LEAF_ID }]),
          snapshotVersion: 5
        }
      ]
    })

    const capable = await listForClient(runtime, [
      SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY
    ])

    expect(capable.tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'moved-tab',
        exited: expect.objectContaining({ exitCode: 3 })
      })
    ])
  })

  it('ends the record when the leaf binds its next process, and an older client sees it again', async () => {
    const { runtime, notifier } = makeRendererRuntime(
      rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    )
    runtime.terminalExitRecords.record(exitRecord())
    const retiredFrame = await listForClient(runtime, [])

    // The exited process registering again is not a restart.
    runtime.registerPty(DEAD_PTY_ID, TEST_WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'inc-dead'
    })
    expect(runtime.terminalExitRecords.get(HEADLESS_LEAF_ID)).toBeDefined()

    runtime.registerPty('pty-restarted', TEST_WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'inc-restarted'
    })

    expect(runtime.terminalExitRecords.get(HEADLESS_LEAF_ID)).toBeUndefined()
    expect(notifier.terminalExitRecordsChanged).toHaveBeenLastCalledWith([])
    const live = await listForClient(runtime, [])
    expect(live.tabs).toEqual([expect.objectContaining({ leafId: HEADLESS_LEAF_ID })])
    // The client ledger drops a proof once its surface is published live again.
    expect(
      dropRetirementProofsForLiveSurfaces(retiredFrame.retiredTerminalSurfaces ?? [], live.tabs)
    ).toEqual([])
  })

  it('ends the record when its leaf leaves the session, so a reopened tab spawns fresh', async () => {
    const { runtimeStore, getSession, setSession } = sessionStoreWithHostTab()
    const beforeClose = getSession()
    const snapshot = rendererSnapshot([{ tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }])
    const { runtime, notifier } = makeRendererRuntime(snapshot, runtimeStore)
    runtime.terminalExitRecords.record(exitRecord())

    runtime.closeTerminalSurfaceFromRenderer(TEST_WORKTREE_ID, { kind: 'tab', tabId: 'host-tab' })
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [{ ...snapshot, snapshotVersion: 2, activeTabId: null, tabs: [] }]
    })
    expect(runtime.terminalExitRecords.get(HEADLESS_LEAF_ID)).toBeUndefined()
    // Why: the desktop mount check reads this mirror; a stale entry would show the reopened pane exited.
    expect(notifier.terminalExitRecordsChanged).toHaveBeenLastCalledWith([])

    // Reopening a recently closed tab restores it with its original ids.
    setSession(beforeClose)
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [{ ...snapshot, snapshotVersion: 9 }]
    })
    const reopened = await listForClient(runtime, [
      SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY
    ])

    expect(reopened.tabs).toEqual([expect.objectContaining({ leafId: HEADLESS_LEAF_ID })])
    expect(reopened.tabs[0]).not.toHaveProperty('exited')
  })

  it('keeps showing a closing leaf as exited until the session removes it', async () => {
    const { runtimeStore } = sessionStoreWithHostTab()
    const { runtime } = makeRendererRuntime(
      rendererSnapshot([{ tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }]),
      runtimeStore
    )
    runtime.terminalExitRecords.record(exitRecord())

    // The close intent lands before the renderer's graph sync removes the leaf.
    runtime.closeTerminalSurfaceFromRenderer(TEST_WORKTREE_ID, { kind: 'tab', tabId: 'host-tab' })
    const between = await listForClient(runtime, [
      SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY
    ])

    // Why: a frame here without the exit would show a still-listed leaf as starting.
    expect(between.tabs).toEqual([
      expect.objectContaining({ leafId: HEADLESS_LEAF_ID, exited: expect.any(Object) })
    ])
  })

  it('keeps the record of a leaf the session has not listed yet', () => {
    const { runtime } = makeRendererRuntime(
      rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    )
    // An instant-exit split: kept before the renderer first publishes its leaf.
    const unpublished = exitRecord({ leafId: SIBLING_LEAF_ID })
    runtime.terminalExitRecords.record(unpublished)

    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        { ...rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }]), snapshotVersion: 4 }
      ]
    })

    expect(runtime.terminalExitRecords.list()).toEqual([unpublished])
  })

  it("ends a headless close's record in the frame that removes its leaf", async () => {
    const { runtime } = makePendingAgentTabActivationRuntime()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    runtime.terminalExitRecords.record(exitRecord({ ptyId: 'serve-dead-pty' }))
    const recordAtFrame: (TerminalExitRecord | undefined)[] = []
    runtime.onMobileSessionTabsChanged((frame) => {
      if (!frame.tabs.some((tab) => tab.type === 'terminal' && tab.leafId === HEADLESS_LEAF_ID)) {
        recordAtFrame.push(runtime.terminalExitRecords.get(HEADLESS_LEAF_ID))
      }
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(recordAtFrame.length).toBeGreaterThan(0)
    expect(recordAtFrame).toEqual(recordAtFrame.map(() => undefined))
  })

  it("ends every record of a removed worktree's session, and only that worktree's", () => {
    const { runtime, notifier } = makeRendererRuntime(
      rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    )
    const otherWorktreeRecord = exitRecord({
      worktreeId: 'repo-1::/tmp/worktree-b',
      leafId: SIBLING_LEAF_ID
    })
    runtime.terminalExitRecords.record(exitRecord())
    runtime.terminalExitRecords.record(otherWorktreeRecord)
    const removalStore = {
      ...store,
      getWorktreeMeta: () => undefined,
      removeWorktreeMeta: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every worktree removal path funnels through this protected runtime method.
    const internals = runtime as unknown as {
      removeWorktreeMetadataAndHistory: (store: unknown, worktreeId: string) => void
    }

    internals.removeWorktreeMetadataAndHistory(removalStore, TEST_WORKTREE_ID)

    expect(runtime.terminalExitRecords.list()).toEqual([otherWorktreeRecord])
    expect(notifier.terminalExitRecordsChanged).toHaveBeenLastCalledWith([otherWorktreeRecord])
  })

  it("gives a client without the capability exactly today's projection of an exit", async () => {
    const graph = (ptyId: string | null) => ({
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId,
          paneTitle: null
        }
      ],
      mobileSessionTabs: [
        rendererSnapshot([
          { tabId: 'host-tab', leafId: HEADLESS_LEAF_ID, ...(ptyId ? { ptyId } : {}) }
        ])
      ]
    })
    // Today: main retires the surface when its process dies.
    const today = makeRendererRuntime(
      graph(DEAD_PTY_ID).mobileSessionTabs[0]!,
      sessionStoreWithHostTab(DEAD_PTY_ID).runtimeStore
    ).runtime
    today.registerPty(DEAD_PTY_ID, TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'inc-dead'
    })
    today.attachWindow(1)
    today.syncWindowGraph(1, graph(DEAD_PTY_ID))
    const live = await listForClient(today, [])
    expect(live.tabs).toEqual([expect.objectContaining({ status: 'ready' })])
    today.onPtyExit(DEAD_PTY_ID, 3, 'inc-dead')
    const retired = await listForClient(today, [])
    const handle = retired.retiredTerminalSurfaces?.[0]?.terminal
    expect(handle).toEqual(expect.any(String))

    // Kept: the binding is cleared and main holds the exit record instead.
    const kept = makeRendererRuntime(
      graph(null).mobileSessionTabs[0]!,
      sessionStoreWithHostTab().runtimeStore
    ).runtime
    kept.attachWindow(1)
    kept.syncWindowGraph(1, graph(null))
    kept.terminalExitRecords.record(exitRecord({ terminal: handle }))
    const projected = await listForClient(kept, [])

    const { snapshotVersion: _retiredVersion, ...retiredView } = retired
    const { snapshotVersion: _keptVersion, ...keptView } = projected
    // Why structural, not string-equal: clients read fields by name, so key order is not on the wire.
    expect(keptView).toEqual(retiredView)
  })

  it.each(['mounted', 'unmounted', 'reloading'] as const)(
    'restarts a %s desktop leaf as one plain-shell runtime spawn with its shell, surfacing nothing',
    async (desktop) => {
      const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      try {
        const snapshot = rendererSnapshot([{ tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }])
        const { runtime, spawn, notifier } = makeRendererRuntime(
          snapshot,
          sessionStoreWithHostTab(undefined, 'cmd.exe').runtimeStore
        )
        if (desktop !== 'unmounted') {
          publishDesktopGraph(runtime, snapshot)
        }
        if (desktop === 'reloading') {
          runtime.markRendererReloading(1)
        }
        runtime.terminalExitRecords.record(exitRecord())

        await runtime.activateMobileSessionTab(
          `id:${TEST_WORKTREE_ID}`,
          'host-tab',
          HEADLESS_LEAF_ID,
          { notifyClients: false, intent: 'user' }
        )

        expect(spawn).toHaveBeenCalledTimes(1)
        const request = spawn.mock.calls[0]![0]
        expect(request).toMatchObject({ tabId: 'host-tab', leafId: HEADLESS_LEAF_ID })
        expect(request.command).toBeUndefined()
        // Why: the shell is what this terminal is, never a command typed into the default shell.
        expect(request.shellOverride).toBe('cmd.exe')
        // Why: a `serve-` id would reclassify a desktop tab as runtime-owned.
        expect(request.sessionId).toBeUndefined()
        expect(notifier.revealTerminalSession).toHaveBeenCalledWith(
          TEST_WORKTREE_ID,
          expect.objectContaining({
            tabId: 'host-tab',
            leafId: HEADLESS_LEAF_ID,
            activate: false,
            surfaceOwner: false
          })
        )
        // Why: a phone-local restart must not move the desktop's focus.
        expect(notifier.focusTerminal).not.toHaveBeenCalled()
        expect(runtime.terminalExitRecords.get(HEADLESS_LEAF_ID)).toBeUndefined()
      } finally {
        Object.defineProperty(process, 'platform', hostPlatform)
      }
    }
  )

  it('focuses the desktop pane after a restart only when the navigation targets the host', async () => {
    const snapshot = rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    const { runtime, notifier } = makeRendererRuntime(snapshot)
    publishDesktopGraph(runtime, snapshot)
    runtime.terminalExitRecords.record(exitRecord())

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID, HEADLESS_LEAF_ID, {
      intent: 'user'
    })

    expect(notifier.revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({ surfaceOwner: false })
    )
    expect(notifier.focusTerminal).toHaveBeenCalledExactlyOnceWith(
      TAB_ID,
      TEST_WORKTREE_ID,
      HEADLESS_LEAF_ID
    )
  })

  it("starts one process for a repeated restart, and the desktop pane's spawn attaches to it", async () => {
    const snapshot = rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    const { runtime, spawn } = makeRendererRuntime(snapshot)
    publishDesktopGraph(runtime, snapshot)
    runtime.terminalExitRecords.record(exitRecord())
    const activate = () =>
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID, HEADLESS_LEAF_ID, {
        notifyClients: false,
        intent: 'user'
      })

    // A second tap lands while the first restart is still spawning.
    await Promise.all([activate(), activate()])

    expect(spawn).toHaveBeenCalledTimes(1)
    // The owner a desktop `pty:spawn` for this pane key resolves, and attaches to instead of spawning.
    expect(
      resolveStablePaneOwner(
        runtime,
        store,
        makePaneKey(TAB_ID, HEADLESS_LEAF_ID),
        TEST_WORKTREE_ID,
        null
      )
    ).toMatchObject({ ptyId: 'pty-runtime-spawn' })
  })

  it('never restarts or focuses an exited leaf for an automatic probe', async () => {
    const { runtime, spawn, notifier } = makeRendererRuntime(
      rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    )
    runtime.terminalExitRecords.record(exitRecord())

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID, HEADLESS_LEAF_ID, {
      intent: 'automatic'
    })

    expect(notifier.focusTerminal).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('restarts a headless exited agent tab as a plain shell, never through materialize', async () => {
    const { runtime, spawn } = makePendingAgentTabActivationRuntime()
    runtime.terminalExitRecords.record(exitRecord({ ptyId: 'serve-dead-pty' }))

    await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`,
      undefined,
      { notifyClients: false, intent: 'user' }
    )

    expect(spawn).toHaveBeenCalledTimes(1)
    const request = spawn.mock.calls[0]![0]
    expect(request).toMatchObject({ tabId: 'host-tab', leafId: HEADLESS_LEAF_ID })
    expect(request.command).toBeUndefined()
    // Why: materialize reattaches the tab's recorded session and relaunches its agent.
    expect(request.sessionId).not.toBe('serve-dead-pty')
    // Why: the dead process was runtime-owned, and its restart stays so.
    expect(request.sessionId).toMatch(/^serve-/)
    expect(runtime.terminalExitRecords.get(HEADLESS_LEAF_ID)).toBeUndefined()
  })
})
