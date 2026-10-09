import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { SURFACE_CLAIM_WITHOUT_STANDING } from './pty-recorded-surface-topology'

// #18191: a headless server publishes one empty placeholder graph at launch so status clients see
// a ready server. That statement names no renderer pane and is never replaced, so if it counts as
// a graph statement every claim written without standing — a persisted replay, an inventory
// restore, a TUI-owner recovery — is contradicted by an empty leaf map that can never re-stamp it.
// The terminal then reports `orphaned: true` under a `pty:` tabId for the life of the process.

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const LEAF = '33333333-3333-4333-8333-333333333333'
const PTY = 'pty-headless-restored'

function makeStore() {
  return {
    getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
    setWorkspaceSession: vi.fn(),
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

/** A headless host: no renderer ever attaches, and the only graph is the launch placeholder. */
function makeHeadlessRuntime(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore returns the repo and session reads this suite drives; the rest of Store is unreached.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub carries the members this suite drives; the PTY stays live throughout.
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () => [{ id: PTY, cwd: '/tmp/probe-worktree' }])
  } as never)
  return runtime
}

/** Reaching `recordPtyWorktree` is the only way to write a claim the way a replay path does. */
function recordSurfaceWithoutStanding(runtime: OrcaRuntimeService): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recordPtyWorktree is protected; the replay paths this stands in for all reach it.
  const internals = runtime as unknown as {
    recordPtyWorktree: (ptyId: string, worktreeId: string, state: Record<string, unknown>) => void
  }
  internals.recordPtyWorktree(PTY, WORKTREE_ID, { connected: true })
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

    // The placeholder says "no renderer panes here", not "the pane you restored is gone".
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
    // The projection an orphan verdict forces, which `terminal close --tab` cannot resolve.
    expect(restored?.tabId).toBe('tab-restored')
  })

  it('still lets a real renderer graph contradict the same claim', async () => {
    const runtime = makeHeadlessRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    recordSurfaceWithoutStanding(runtime)
    // Negative control: a desktop window promoted from headless publishes a graph that does have
    // standing over panes. Its silence about this one is a retraction, and must still be read as
    // such — otherwise this fix would have re-broken #18191 on every promoted host.
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    const restored = terminals.find((terminal) => terminal.ptyId === PTY)
    expect(restored?.orphaned).toBe(true)
    expect(restored?.tabId).toBe(`pty:${PTY}`)
  })
})
