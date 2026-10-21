// Layout-owner build: main's one start of a restored pane, shared by a client's first view and a
// CLI or orchestration trigger.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const PANE = { worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }

function windowlessRuntime() {
  // The pane's stored terminal is gone: the host lists no live terminal.
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  const started = deferred<{ id: string }>()
  const spawn = vi.fn(() => started.promise)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, spawn, started, getSession, setSession }
}

describe('a restored pane with no live terminal, on a host with no window (layout-owner build)', () => {
  it('starts once from its stored terminal for a client first view and a CLI trigger together', async () => {
    const { runtime, spawn, started } = windowlessRuntime()

    const firstView = runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false, navigation: 'caller', intent: 'user' }
    )
    const cliSend = runtime.ensureRestoredPaneStarted(PANE)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.resolve({ id: 'persisted-pty' })

    await expect(cliSend).resolves.toEqual({ id: 'persisted-pty' })
    await firstView
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'persisted-pty', tabId: 'host-tab' })
    )
    // Live now: a later trigger starts nothing.
    await expect(runtime.ensureRestoredPaneStarted(PANE)).resolves.toEqual({ id: 'persisted-pty' })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('answers null for a pane main no longer holds, starting nothing', async () => {
    const { runtime, spawn } = windowlessRuntime()

    await expect(
      runtime.ensureRestoredPaneStarted({ ...PANE, tabId: 'tab-gone' })
    ).resolves.toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('resolves to the terminal its start registered, not the id the pane stored', async () => {
    const { runtime, started } = windowlessRuntime()

    const cliSend = runtime.ensureRestoredPaneStarted(PANE)
    started.resolve({ id: 'pty-fresh' })

    await expect(cliSend).resolves.toEqual({ id: 'pty-fresh' })
  })

  it("refuses a client's first view of a pane main dropped after the client listed it", async () => {
    const { runtime, spawn, getSession, setSession } = windowlessRuntime()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const session = getSession()
    setSession({
      ...session,
      tabsByWorktree: { ...session.tabsByWorktree, [TEST_WORKTREE_ID]: [] }
    })

    await expect(
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      })
    ).rejects.toThrow('tab_not_found')
    expect(spawn).not.toHaveBeenCalled()
  })
})
