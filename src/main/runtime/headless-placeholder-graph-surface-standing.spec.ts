import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { SURFACE_CLAIM_WITHOUT_STANDING } from './pty-recorded-surface-topology'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { bindPaneFirst } from './bind-first-pane.test-fixture'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

export function registerHeadlessPlaceholderGraphSurfaceStandingTests(): void {
  // #18191: the launch placeholder makes status ready but has no renderer authority to retract restored panes.
  // Main-owned layouts bind restored terminals directly; switch-off builds must not count the placeholder as a graph statement.

  const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
  const LEAF = '33333333-3333-4333-8333-333333333333'
  const PTY = 'pty-headless-restored'

  function makeStore() {
    let session = getDefaultWorkspaceSession()
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

  function makeHeadlessRuntime(): OrcaRuntimeService {
    const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub carries the members this suite drives; the PTY stays live throughout.
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true,
      listProcesses: vi.fn(async () => [{ id: PTY, cwd: '/tmp/probe-worktree' }])
    } as never)
    return runtime
  }

  function recordSurfaceWithoutStanding(runtime: OrcaRuntimeService): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recordPtyWorktree is protected; the replay paths this stands in for all reach it.
    const internals = runtime as unknown as {
      recordPtyWorktree: (ptyId: string, worktreeId: string, state: Record<string, unknown>) => void
    }
    internals.recordPtyWorktree(PTY, WORKTREE_ID, { connected: true })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      bindPaneFirst(runtime, {
        worktreeId: WORKTREE_ID,
        tabId: 'tab-restored',
        leafId: LEAF,
        ptyId: PTY
      })
      return
    }
    internals.recordPtyWorktree(PTY, WORKTREE_ID, {
      connected: true,
      tabId: 'tab-restored',
      paneKey: makePaneKey('tab-restored', LEAF),
      surfaceRecordedAtGraphSequence: SURFACE_CLAIM_WITHOUT_STANDING
    })
  }

  describe('headless placeholder graph and surface standing', () => {
    it('does not spend a graph statement on the launch placeholder', () => {
      const runtime = makeHeadlessRuntime()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: graphSequence is protected; the count is the whole property under test.
      const internals = runtime as unknown as { graphSequence: number }
      expect(internals.graphSequence).toBe(0)

      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      expect(internals.graphSequence).toBe(0)
    })

    it('keeps a restored surface attached on a headless host', async () => {
      const runtime = makeHeadlessRuntime()
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      recordSurfaceWithoutStanding(runtime)

      const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      const restored = terminals.find((terminal) => terminal.ptyId === PTY)
      expect(restored).toBeDefined()
      expect(restored?.orphaned).toBe(false)
      expect(restored?.tabId).toBe('tab-restored')
    })

    it('still lets a real renderer graph contradict the same claim', async () => {
      const runtime = makeHeadlessRuntime()
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      recordSurfaceWithoutStanding(runtime)
      // A real renderer retracts claims in switch-off builds; main-owned builds retain them until layout removal.
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        const attached = await runtime.listTerminals(`id:${WORKTREE_ID}`)
        const kept = attached.terminals.find((terminal) => terminal.ptyId === PTY)
        expect(kept?.orphaned).toBe(false)
        expect(kept?.tabId).toBe('tab-restored')
        runtime['store']?.setWorkspaceSession?.(getDefaultWorkspaceSession())
        // Fixture stores lack notifications; graph sync reloads main's panes.
        runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      }

      const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
      const restored = terminals.find((terminal) => terminal.ptyId === PTY)
      expect(restored?.orphaned).toBe(true)
      expect(restored?.tabId).toBe(`pty:${PTY}`)
    })
  })
}
