// L80 (P3): a terminal record that arrives, or changes incarnation, after main composed its panes
// re-composes them, so a pane its saved layout binds lists once, with that terminal.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

await import('../../orca-runtime-test-mocks.spec')
await import('../../orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime-test-mocks.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../orca-runtime-test-fixtures.spec')

type Listed = { id: string; incarnationId: string; connected: boolean }

/** A restarted host: the saved pane binds `persisted-pty`, stamped with the process now running. */
function restartedHost(stamp: string, listedByHost: () => Listed[]) {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      terminalPtyIncarnationsByPaneKey: { [`host-tab:${HEADLESS_LEAF_ID}`]: stamp }
    })
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    hasPty: (ptyId: string) => listedByHost().some((pty) => pty.id === ptyId && pty.connected),
    listProcesses: async () =>
      listedByHost()
        .filter((pty) => pty.connected)
        .map((pty) => ({
          id: pty.id,
          incarnationId: pty.incarnationId,
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }))
  })
  // Main composes its panes before the first inventory registers any terminal.
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return runtime
}

async function hostTabRows(runtime: ReturnType<typeof restartedHost>) {
  const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
  return listed.terminals
    .filter((terminal) => terminal.tabId === 'host-tab')
    .map((terminal) => ({ ptyId: terminal.ptyId, incarnationId: terminal.incarnationId }))
}

describe('a terminal record arriving after main composed its panes (switch on)', () => {
  it('lists the restored pane once, with the terminal its saved layout binds', async () => {
    const runtime = restartedHost('inc-now', () => [
      { id: 'persisted-pty', incarnationId: 'inc-now', connected: true }
    ])

    expect(await hostTabRows(runtime)).toEqual([
      { ptyId: 'persisted-pty', incarnationId: 'inc-now' }
    ])
  })

  it('re-composes when the record learns the incarnation the pane is stamped with', async () => {
    let incarnationId = 'inc-before'
    const runtime = restartedHost('inc-now', () => [
      { id: 'persisted-pty', incarnationId, connected: true }
    ])
    await hostTabRows(runtime)

    // The same connected terminal adopts the stamped process: no connection change.
    incarnationId = 'inc-now'

    expect(await hostTabRows(runtime)).toEqual([
      { ptyId: 'persisted-pty', incarnationId: 'inc-now' }
    ])
  })

  it('publishes nothing when an unchanged inventory refresh records the same terminal', async () => {
    const runtime = restartedHost('inc-now', () => [
      { id: 'persisted-pty', incarnationId: 'inc-now', connected: true }
    ])
    await hostTabRows(runtime)
    await new Promise((resolve) => setImmediate(resolve))
    const published = vi.spyOn(runtime, 'syncWindowGraph')

    await hostTabRows(runtime)
    await new Promise((resolve) => setImmediate(resolve))

    expect(published).not.toHaveBeenCalled()
  })

  it('re-composes when the record moves to another workspace', async () => {
    const runtime = restartedHost('inc-now', () => [
      { id: 'persisted-pty', incarnationId: 'inc-now', connected: true }
    ])
    // A window publishes, so main republishes its panes when a record changes.
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: [] })
    expect(await hostTabRows(runtime)).toEqual([
      { ptyId: 'persisted-pty', incarnationId: 'inc-now' }
    ])

    await new Promise((resolve) => setImmediate(resolve))
    const published = vi.spyOn(runtime, 'syncWindowGraph')
    // A writer that resolves the terminal to another workspace (a worktree-identity migration).
    runtime['recordPtyWorktree']('persisted-pty', 'repo-1::/tmp/worktree-b')
    await new Promise((resolve) => setImmediate(resolve))

    // The saved pane no longer holds a terminal of another workspace.
    expect(runtime['paneOfPty'](runtime['ptysById'].get('persisted-pty')).tabId).toBeNull()
    // Main republished its panes: both workspaces' leaves re-compose against the moved record.
    expect(published).toHaveBeenCalled()
  })
})
