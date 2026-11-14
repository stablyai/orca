// Late terminal records and incarnation changes must recompose main-owned panes, listing each bound terminal once.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')

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
  it('re-composes when the record learns the incarnation the pane is stamped with', async () => {
    let incarnationId = 'inc-before'
    const runtime = restartedHost('inc-now', () => [
      { id: 'persisted-pty', incarnationId, connected: true }
    ])
    await hostTabRows(runtime)

    incarnationId = 'inc-now'

    expect(await hostTabRows(runtime)).toEqual([
      { ptyId: 'persisted-pty', incarnationId: 'inc-now' }
    ])
  })
})
