import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// #18191: a terminal whose pane the graph dropped kept reporting `orphaned: false` with a
// `tabId` no tab has — "field-for-field identical to a healthy one", so an operator polling
// `terminal list` had no signal at all. The runtime asked whether the PTY record agreed with
// itself; it never asked the leaf topology whether that pane still exists.

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const KEPT_LEAF = '11111111-1111-4111-8111-111111111111'
const DROPPED_LEAF = '22222222-2222-4222-8222-222222222222'
const KEPT_PTY = 'pty-ui-created'
const DROPPED_PTY = 'pty-cli-created'

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
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

/** Both PTYs stay live on the host throughout; only the graph changes. */
function makeRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () => [
      { id: KEPT_PTY, cwd: '/tmp/probe-worktree' },
      { id: DROPPED_PTY, cwd: '/tmp/probe-worktree' }
    ])
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [tab('tab-kept', KEPT_LEAF), tab('tab-dropped', DROPPED_LEAF)],
    leaves: [leaf('tab-kept', KEPT_LEAF, KEPT_PTY), leaf('tab-dropped', DROPPED_LEAF, DROPPED_PTY)]
  })
  return runtime
}

/** The restart republishes a graph that kept one pane and dropped the other. */
function dropOnePane(runtime: OrcaRuntimeService): void {
  runtime.syncWindowGraph(1, {
    tabs: [tab('tab-kept', KEPT_LEAF)],
    leaves: [leaf('tab-kept', KEPT_LEAF, KEPT_PTY)]
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
    // Re-recording the dropped pane stands in for that: the graph has not spoken since, so its
    // silence is not a retraction. This also pins that the runtime stamps the record at all —
    // orca-runtime-record-pty-worktree.ts is `@ts-nocheck`, so a missing stamp is silent there
    // and would leave every freshly spawned terminal reporting orphaned for one graph.
    ;(
      runtime as unknown as {
        recordPtyWorktree: (
          ptyId: string,
          worktreeId: string,
          state: Record<string, unknown>
        ) => void
      }
    ).recordPtyWorktree(DROPPED_PTY, WORKTREE_ID, {
      connected: true,
      tabId: 'tab-dropped',
      paneKey: `tab-dropped:${DROPPED_LEAF}`
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    const dropped = terminals.find((terminal) => terminal.ptyId === DROPPED_PTY)
    expect(dropped?.orphaned).toBe(false)
  })

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
