import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/terminal-tab-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { spawnSurfaceClaimSequence } from './pty-recorded-surface-topology'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { bindPaneFirst } from './bind-first-pane.test-fixture'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

export function registerTerminalListSurfaceLostOrphanTests(): void {
  // #18191: a terminal whose pane the graph dropped kept reporting `orphaned: false` with a
  // `tabId` no tab has — "field-for-field identical to a healthy one", so an operator polling
  // `terminal list` had no signal at all. The runtime asked whether the PTY record agreed with
  // itself; it never asked the leaf topology whether that pane still exists.
  // Layout-owner builds: a terminal holds its surface exactly when main's layout binds it, so the
  // pane drops out of main's layout, not out of the window's graph; window graphs never retract it.

  const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
  const KEPT_LEAF = '11111111-1111-4111-8111-111111111111'
  const DROPPED_LEAF = '22222222-2222-4222-8222-222222222222'
  const KEPT_PTY = 'pty-ui-created'
  const DROPPED_PTY = 'pty-cli-created'
  const KEPT_INCARNATION = 'inc-kept'
  const DROPPED_INCARNATION = 'inc-dropped'

  function persistedTab(id: string): TerminalTab {
    return {
      id,
      ptyId: null,
      worktreeId: WORKTREE_ID,
      title: '',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
  }

  /** Only ptyIdsByLeafId is read by indexPersistedPtySurfaceBindings; the rest stays inert. */
  function persistedLayout(leafId: string, ptyId: string): TerminalLayoutSnapshot {
    return {
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: ptyId }
    }
  }

  /** A session that still persists both panes, exactly as it is between a graph drop and the next save. */
  function sessionStillHoldingBothPanes(): WorkspaceSessionState {
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree = {
      [WORKTREE_ID]: [persistedTab('tab-kept'), persistedTab('tab-dropped')]
    }
    session.terminalLayoutsByTabId = {
      'tab-kept': persistedLayout(KEPT_LEAF, KEPT_PTY),
      'tab-dropped': persistedLayout(DROPPED_LEAF, DROPPED_PTY)
    }
    session.terminalPtyIncarnationsByPaneKey = {
      [makePaneKey('tab-kept', KEPT_LEAF)]: KEPT_INCARNATION,
      [makePaneKey('tab-dropped', DROPPED_LEAF)]: DROPPED_INCARNATION
    }
    return session
  }

  function makeStore(initialSession: WorkspaceSessionState = getDefaultWorkspaceSession()) {
    let session = initialSession
    return {
      getWorkspaceSession: vi.fn(() => session),
      setWorkspaceSession: vi.fn((next: WorkspaceSessionState) => {
        session = next
      }),
      getRepos: vi.fn(() => [
        {
          id: 'repo-1',
          path: '/tmp/probe-worktree',
          displayName: 'probe',
          badgeColor: '#000000',
          addedAt: 0
        }
      ]),
      getAllWorktreeMeta: vi.fn(() => ({})),
      getWorktreeMeta: vi.fn(() => undefined),
      setWorktreeMeta: vi.fn(),
      removeWorktreeMeta: vi.fn(),
      getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
      getProjects: vi.fn(() => [])
    }
  }

  function leaf(tabId: string, leafId: string, ptyId: string) {
    return {
      tabId,
      worktreeId: WORKTREE_ID,
      leafId,
      paneRuntimeId: 1,
      ptyId,
      paneTitle: null,
      title: ''
    }
  }

  function tab(tabId: string, activeLeafId: string) {
    return { tabId, worktreeId: WORKTREE_ID, title: '', activeLeafId, layout: null }
  }

  const storesByRuntime = new WeakMap<OrcaRuntimeService, ReturnType<typeof makeStore>>()

  function pane(tabId: string, leafId: string, ptyId: string) {
    return { worktreeId: WORKTREE_ID, tabId, leafId, ptyId }
  }

  /** Both PTYs stay live on the host throughout; only the graph changes. */
  function makeRuntime(session?: WorkspaceSessionState): OrcaRuntimeService {
    const store = makeStore(session)
    const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
    storesByRuntime.set(runtime, store)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub carries the four controller members this suite drives; both PTYs stay live throughout.
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true,
      listProcesses: vi.fn(async () => [
        { id: KEPT_PTY, cwd: '/tmp/probe-worktree', incarnationId: KEPT_INCARNATION },
        { id: DROPPED_PTY, cwd: '/tmp/probe-worktree', incarnationId: DROPPED_INCARNATION }
      ])
    } as never)
    bindPaneFirst(runtime, pane('tab-kept', KEPT_LEAF, KEPT_PTY))
    bindPaneFirst(runtime, pane('tab-dropped', DROPPED_LEAF, DROPPED_PTY))
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [tab('tab-kept', KEPT_LEAF), tab('tab-dropped', DROPPED_LEAF)],
      leaves: [
        leaf('tab-kept', KEPT_LEAF, KEPT_PTY),
        leaf('tab-dropped', DROPPED_LEAF, DROPPED_PTY)
      ]
    })
    return runtime
  }

  /** The restart republishes a graph that kept one pane and dropped the other. */
  function dropOnePane(runtime: OrcaRuntimeService): void {
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      unbindDroppedPane(runtime)
    }
    runtime.syncWindowGraph(1, {
      tabs: [tab('tab-kept', KEPT_LEAF)],
      leaves: [leaf('tab-kept', KEPT_LEAF, KEPT_PTY)]
    })
  }

  /** Layout-owner builds: main's layout closes the dropped pane's tab. */
  function unbindDroppedPane(runtime: OrcaRuntimeService): void {
    const store = storesByRuntime.get(runtime)!
    const session = store.getWorkspaceSession()
    const { 'tab-dropped': _dropped, ...layouts } = session.terminalLayoutsByTabId
    store.setWorkspaceSession({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [WORKTREE_ID]: (session.tabsByWorktree[WORKTREE_ID] ?? []).filter(
          (candidate) => candidate.id !== 'tab-dropped'
        )
      },
      terminalLayoutsByTabId: layouts
    })
  }

  describe('terminal inventory after a pane is dropped', () => {
    it('reports both terminals attached while both panes exist', async () => {
      const runtime = makeRuntime()
      const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      const byPty = new Map(terminals.map((terminal) => [terminal.ptyId, terminal]))
      expect(byPty.get(KEPT_PTY)?.orphaned).toBe(false)
      expect(byPty.get(DROPPED_PTY)?.orphaned).toBe(false)
    })

    it('distinguishes the surface-lost terminal from the healthy one', async () => {
      const runtime = makeRuntime()
      dropOnePane(runtime)

      const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      const byPty = new Map(terminals.map((terminal) => [terminal.ptyId, terminal]))
      const kept = byPty.get(KEPT_PTY)
      const dropped = byPty.get(DROPPED_PTY)

      // The whole defect in one line: these two readings used to be identical.
      expect(dropped?.orphaned).not.toBe(kept?.orphaned)
      expect(dropped?.orphaned).toBe(true)
      expect(kept?.orphaned).toBe(false)
    })

    it('stops pointing callers at the tab that no longer exists', async () => {
      const runtime = makeRuntime()
      dropOnePane(runtime)

      const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      const dropped = terminals.find((terminal) => terminal.ptyId === DROPPED_PTY)
      // `terminal close --tab tab-dropped` is what returned `tab_not_found` (#18191 §5).
      expect(dropped?.tabId).not.toBe('tab-dropped')
      expect(dropped?.tabId).toBe(`pty:${DROPPED_PTY}`)
    })

    it('names the pane the dropped terminal was last recorded in, and only for the orphan', async () => {
      const runtime = makeRuntime()
      dropOnePane(runtime)

      const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      const byPty = new Map(terminals.map((terminal) => [terminal.ptyId, terminal]))
      // The renderer may still hold that pane unmounted; it needs the name to rebind instead of forking.
      // Layout-owner builds: views draw main's layout, which no longer has the pane to name.
      expect(byPty.get(DROPPED_PTY)?.recordedPaneKey).toBe(
        ORCA_LAYOUT_OWNER_IS_MAIN ? undefined : makePaneKey('tab-dropped', DROPPED_LEAF)
      )
      expect(byPty.get(KEPT_PTY)).not.toHaveProperty('recordedPaneKey')
    })

    it('keeps reporting the live PTY rather than dropping it from inventory', async () => {
      const runtime = makeRuntime()
      dropOnePane(runtime)

      const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      // Losing a surface is not evidence the process ended; it must stay listed and connected.
      const dropped = terminals.find((terminal) => terminal.ptyId === DROPPED_PTY)
      expect(dropped).toBeDefined()
      expect(dropped?.connected).toBe(true)
    })

    it('does not call a surface recorded since the last graph statement orphaned', async () => {
      const runtime = makeRuntime()
      dropOnePane(runtime)
      // Spawn records the renderer's pane identity before the graph carrying it arrives (#7587).
      // Re-recording waits for the first graph statement; prior silence cannot retract the claim.
      // Layout-owner builds: the spawn commit binds the pane in main's layout, which no graph outranks.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        bindPaneFirst(runtime, pane('tab-dropped', DROPPED_LEAF, DROPPED_PTY))
      } else {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recordPtyWorktree is protected; reaching it is the only way to stamp a pane the graph never published.
        const stamp = runtime as unknown as {
          recordPtyWorktree: (
            ptyId: string,
            worktreeId: string,
            state: Record<string, unknown>
          ) => void
          graphSequence: number
        }
        stamp.recordPtyWorktree(DROPPED_PTY, WORKTREE_ID, {
          connected: true,
          tabId: 'tab-dropped',
          paneKey: `tab-dropped:${DROPPED_LEAF}`,
          surfaceRecordedAtGraphSequence: spawnSurfaceClaimSequence(stamp.graphSequence)
        })
      }

      const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      const dropped = terminals.find((terminal) => terminal.ptyId === DROPPED_PTY)
      expect(dropped?.orphaned).toBe(false)
    })

    it('does not let the inventory restore un-drop a pane the graph dropped', async () => {
      // `list` always refreshes PTY records from the controller inventory first, and that refresh
      // replays the still-persisted paneKey. Stamping that replay at write time gave it the standing
      // of a fresh graph statement, so the very read that reports the orphan erased it first.
      const runtime = makeRuntime(sessionStillHoldingBothPanes())
      dropOnePane(runtime)

      const first = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      const second = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      for (const { terminals } of [first, second]) {
        const byPty = new Map(terminals.map((terminal) => [terminal.ptyId, terminal]))
        expect(byPty.get(DROPPED_PTY)?.orphaned).toBe(true)
        expect(byPty.get(DROPPED_PTY)?.tabId).toBe(`pty:${DROPPED_PTY}`)
        expect(byPty.get(KEPT_PTY)?.orphaned).toBe(false)
      }
    })

    it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
      "keeps a pane main's layout still binds attached when a window graph drops it",
      async () => {
        const runtime = makeRuntime()
        runtime.syncWindowGraph(1, {
          tabs: [tab('tab-kept', KEPT_LEAF)],
          leaves: [leaf('tab-kept', KEPT_LEAF, KEPT_PTY)]
        })

        const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
        const dropped = terminals.find((terminal) => terminal.ptyId === DROPPED_PTY)
        expect(dropped?.orphaned).toBe(false)
        expect(dropped?.tabId).toBe('tab-dropped')
      }
    )

    it('does not call every pane orphaned when the graph goes away', async () => {
      const runtime = makeRuntime()
      // Losing the authoritative graph clears the leaf map wholesale
      // (transitionGraphReloadToTerminalState). That emptiness says nothing about any individual
      // PTY, so reading it as "no pane holds this" would report every live terminal orphaned at
      // once — the same lie as #18191, pointed the other way.
      runtime.markGraphUnavailable(1)

      const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      expect(terminals.length).toBeGreaterThan(0)
      for (const terminal of terminals) {
        expect(terminal.orphaned).toBe(false)
      }
    })

    it('keeps naming the dropped pane after the graph goes away', async () => {
      const runtime = makeRuntime()
      dropOnePane(runtime)
      runtime.markGraphUnavailable(1)

      const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      const byPty = new Map(terminals.map((terminal) => [terminal.ptyId, terminal]))
      // Losing the graph must not retract an observation already made.
      expect(byPty.get(DROPPED_PTY)?.orphaned).toBe(true)
      expect(byPty.get(KEPT_PTY)?.orphaned).toBe(false)
    })
  })
}
