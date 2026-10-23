// Layout-owner build, a host's restart (L80): main's layout binds a pane to a live terminal from
// disk before the terminal's adoption registers it and its own handle. Clients must not get a
// handle in that gap that later stops being the pane's, or a desktop stays on a second handle.
import { expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-types'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

await import('../../orca-runtime-test-mocks.spec')
await import('../../orca-runtime-test-lifecycle.spec')
const { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, TEST_WORKTREE_PATH } =
  await import('../../orca-runtime-test-fixtures.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime-test-mocks.spec')
const {
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../orca-runtime-test-fixtures.spec')

const TAB = '44444444-4444-4444-8444-444444444444'
// A daemon session id names its worktree, so a record can exist before registration.
const PTY = `${TEST_WORKTREE_ID}@@restored1`
const CONTROLLER_HANDLE = 'term_exported-before-restart'

it('gives a restored pane one handle: none before its adoption registers, then the terminal’s own', async () => {
  const harness = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: TAB,
            ptyId: PTY,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: { [TAB]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: PTY }) },
      terminalPtyIncarnationsByPaneKey: { [`${TAB}:${HEADLESS_LEAF_ID}`]: 'inc-restored' }
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements every method these paths call.
  const runtime = new OrcaRuntimeService(harness.runtimeStore as never)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [{ id: PTY, cwd: TEST_WORKTREE_PATH, title: 'sh' }]
  })
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

  // The adopted start's record exists before its registration (createTerminal, adoptedStablePane).
  runtime['getOrCreatePtyWorktreeRecord'](PTY)
  const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const handedOut = before.tabs.flatMap((tab) =>
    tab.type === 'terminal' && tab.status === 'ready' && tab.terminal ? [tab.terminal] : []
  )
  // The gap only leaves the pane unnamed: it stays in main's layout, and nothing records a close.
  expect(harness.getSession().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId?.[HEADLESS_LEAF_ID]).toBe(
    PTY
  )
  expect(harness.getSession().closedTerminalPanesByPaneKey ?? {}).toEqual({})

  // The adoption completes: the terminal's own handle, then its registration.
  runtime.registerPreAllocatedHandleForPty(PTY, CONTROLLER_HANDLE)
  runtime.registerPty(PTY, TEST_WORKTREE_ID, null, {
    tabId: TAB,
    leafId: HEADLESS_LEAF_ID,
    terminalHandle: CONTROLLER_HANDLE,
    incarnationId: 'inc-restored'
  })
  const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const settled = after.tabs.flatMap((tab) =>
    tab.type === 'terminal' && tab.status === 'ready' && tab.terminal ? [tab.terminal] : []
  )

  expect(settled).toEqual([CONTROLLER_HANDLE])
  // Once adopted, the pane names the terminal again, under its exported handle.
  expect(runtime['paneOfPty'](runtime['ptysById'].get(PTY)).paneKey).toBe(
    `${TAB}:${HEADLESS_LEAF_ID}`
  )
  expect(runtime['getLivePtyForHandle'](CONTROLLER_HANDLE)?.pty.ptyId).toBe(PTY)
  // Any handle handed out in the gap is that same handle, or no longer names the terminal.
  for (const handle of handedOut) {
    expect(handle === CONTROLLER_HANDLE || runtime['getLivePtyForHandle'](handle) === null).toBe(
      true
    )
  }
})
