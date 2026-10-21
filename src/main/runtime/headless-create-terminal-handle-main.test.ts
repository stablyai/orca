// Layout-owner build, no window: a phone's terminal create on a server answers with the running
// terminal, not terminal_handle_stale, once main's layout lists the new pane.
import { expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_WORKTREE_ID, TEST_WORKTREE_PATH } = await import('./orca-runtime-test-fixtures.spec')
const { surfaceRuntime } = await import('./terminal/surface/terminal-surface-replies.test-fixture')

type Runtime = ReturnType<typeof surfaceRuntime>['runtime']

it.each([
  [
    'that never had one',
    (runtime: Runtime) => {
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    }
  ],
  [
    'after its window closed',
    (runtime: Runtime) => {
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.markGraphUnavailable(1)
    }
  ]
])(
  'creates a terminal on a host with no window, %s, and answers with its live handle',
  async (_name, setup) => {
    const { runtime, bindPane } = surfaceRuntime()
    setup(runtime)
    runtime.setPtyController({
      // As the PTY host's spawn commit: it binds the pane before the spawn answers.
      spawn: vi.fn(async (args: { worktreeId?: string; tabId?: string; leafId?: string }) => {
        await bindPane({
          worktreeId: args.worktreeId!,
          tabId: args.tabId!,
          leafId: args.leafId!,
          ptyId: 'pty-new'
        })
        return { id: 'pty-new' }
      }),
      write: () => true,
      kill: () => true,
      stopAndWait: async () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () =>
        ['pty-a', 'pty-b', 'pty-new'].map((id) => ({ id, cwd: TEST_WORKTREE_PATH, title: 'sh' }))
    })

    // A subscribed phone: each row publication names its terminal's handle.
    const unsubscribe = runtime.onMobileSessionTabsChanged(() => {}, 'phone')
    const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      select: false,
      navigation: 'caller',
      clientNavigationId: 'phone'
    })

    unsubscribe()
    expect(created.tab).toMatchObject({ status: 'ready' })
  }
)
