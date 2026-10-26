// Close drops panes before terminal exit; main must recover their closed-pane identity even headless (L80 Q2).
import { expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-types'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

await import('../../orca-runtime-test-mocks.spec')
await import('../../orca-runtime-test-lifecycle.spec')
const { HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, TEST_WORKTREE_ID } =
  await import('../../orca-runtime-test-fixtures.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime-test-mocks.spec')
const { SURFACE_TAB_ID, SURFACE_PTYS, surfaceRuntime } =
  await import('./terminal-surface-replies.test-fixture')

const PANE_A = `${SURFACE_TAB_ID}:${HEADLESS_LEAF_ID}`
const PANE_B = `${SURFACE_TAB_ID}:${HEADLESS_SECOND_LEAF_ID}`
const INCARNATIONS: Record<string, string> = { 'pty-a': 'inc-a', 'pty-b': 'inc-b' }

type Host = 'no window' | 'a window'
type Harness = ReturnType<typeof surfaceRuntime>
type Runtime = Harness['runtime']

/** The scenario's split tab, each pane bound to its terminal's incarnation, as a spawn commit leaves it. */
function closingHost(host: Host): Harness & { reconciled: string[] } {
  const harness = surfaceRuntime()
  const { runtime, store, setSession } = harness
  setSession({
    ...store.getSession(),
    terminalPtyIncarnationsByPaneKey: { [PANE_A]: 'inc-a', [PANE_B]: 'inc-b' }
  })
  for (const [leafId, ptyId] of Object.entries(SURFACE_PTYS)) {
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
      tabId: SURFACE_TAB_ID,
      leafId,
      incarnationId: INCARNATIONS[ptyId]
    })
  }
  if (host === 'a window') {
    runtime.attachWindow(1)
  }
  runtime.syncWindowGraph(host === 'a window' ? 1 : HEADLESS_RUNTIME_WINDOW_ID, {
    tabs: [],
    leaves: []
  })
  const reconciled: string[] = []
  watchReconciled(runtime, reconciled)
  return { ...harness, reconciled }
}

function watchReconciled(runtime: Runtime, into: string[]): void {
  Reflect.set(runtime, 'reconcileAgentStatusForEndedProcessFn', (keys: Set<string>) => {
    into.push(...keys)
  })
}

/** The CLI's close of pty-b's pane by its handle; the tab stays open with pty-a's pane. */
async function closePaneByHandle(runtime: Runtime): Promise<void> {
  const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
  await runtime.closeTerminal(
    listed.terminals.find((terminal) => terminal.ptyId === 'pty-b')!.handle
  )
}

/** The window's own tab close, as `layout.apply` forwards it; the window kills the terminals. */
async function closeTabAsWindow(runtime: Runtime): Promise<void> {
  await runtime['store']!.applyLayoutCommand!(
    {
      type: 'closeTabs',
      workspace: TEST_WORKTREE_ID,
      tabIds: [SURFACE_TAB_ID],
      force: true,
      recordClose: 'user'
    },
    ['local']
  )
}

async function phoneShowsPane(runtime: Runtime, leafId: string): Promise<boolean> {
  const phone = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  return phone.tabs.some(
    (tab) => tab.type === 'terminal' && tab.parentTabId === SURFACE_TAB_ID && tab.leafId === leafId
  )
}

const CLOSES = [
  { route: 'a pane closed by handle in a tab that stays', close: closePaneByHandle },
  { route: 'the window’s tab close', close: closeTabAsWindow }
] as const

for (const host of ['no window', 'a window'] as const) {
  for (const { route, close } of CLOSES) {
    it(`close then exit retires the pane's agent status and phone row: ${route}, with ${host}`, async () => {
      const harness = closingHost(host)

      await close(harness.runtime)
      expect(harness.store.getSession().closedTerminalPanesByPaneKey?.[PANE_B]).toMatchObject({
        ptyId: 'pty-b',
        incarnationId: 'inc-b',
        worktreeId: TEST_WORKTREE_ID
      })
      harness.runtime.onPtyExit('pty-b', 0, 'inc-b')

      expect(harness.reconciled).toContain(PANE_B)
      expect(harness.store.getSession().closedTerminalPanesByPaneKey?.[PANE_B]).toBeUndefined()
      expect(await phoneShowsPane(harness.runtime, HEADLESS_SECOND_LEAF_ID)).toBe(false)
    })

    it(`the exit drops the closed-pane record in its one retirement write: ${route}, with ${host}`, async () => {
      const harness = closingHost(host)
      await close(harness.runtime)
      // The fixture's setter may already be a mock carrying the close's own writes.
      const writes = vi.spyOn(harness.runtime['store']!, 'setWorkspaceSession')
      writes.mockClear()

      harness.runtime.onPtyExit('pty-b', 0, 'inc-b')

      expect(writes).toHaveBeenCalledTimes(1)
      expect(writes.mock.calls[0]![0].closedTerminalPanesByPaneKey?.[PANE_B]).toBeUndefined()
    })

    it(`exit then close retires them too: ${route}, with ${host}`, async () => {
      const harness = closingHost(host)

      harness.runtime.onPtyExit('pty-b', 0, 'inc-b')
      await close(harness.runtime).catch(() => {})

      expect(harness.reconciled).toContain(PANE_B)
      expect(await phoneShowsPane(harness.runtime, HEADLESS_SECOND_LEAF_ID)).toBe(false)
    })

    it(`close, restart, then exit still finds the pane from disk: ${route}, with ${host}`, async () => {
      const harness = closingHost(host)
      await close(harness.runtime)

      // The relaunch reattaches the closed pane's live terminal; no pane holds it any more.
      const relaunched = new OrcaRuntimeService(harness.runtime['store'])
      relaunched.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      if (host === 'a window') {
        relaunched.attachWindow(1)
      }
      relaunched.syncWindowGraph(host === 'a window' ? 1 : HEADLESS_RUNTIME_WINDOW_ID, {
        tabs: [],
        leaves: []
      })
      relaunched.registerPty('pty-b', TEST_WORKTREE_ID)
      relaunched['ptysById'].get('pty-b')!.incarnationId = 'inc-b'
      const reconciled: string[] = []
      watchReconciled(relaunched, reconciled)

      relaunched.onPtyExit('pty-b', 0, 'inc-b')

      expect(reconciled).toContain(PANE_B)
      expect(harness.store.getSession().closedTerminalPanesByPaneKey?.[PANE_B]).toBeUndefined()
    })

    it(`does not take the closed pane for a later incarnation of the id: ${route}, with ${host}`, async () => {
      const harness = closingHost(host)
      await close(harness.runtime)
      harness.runtime['ptysById'].get('pty-b')!.incarnationId = 'inc-later'

      harness.runtime.onPtyExit('pty-b', 0, 'inc-later')

      expect(harness.reconciled).not.toContain(PANE_B)
      expect(harness.store.getSession().closedTerminalPanesByPaneKey?.[PANE_B]).toBeDefined()
    })
  }
}
