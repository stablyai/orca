// Main-owned headless create must bind the pane before returning its usable terminal handle.
import { expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_WORKTREE_ID, TEST_WORKTREE_PATH } = await import('./orca-runtime-test-fixtures.spec')
const { surfaceRuntime } = await import('./terminal/surface/terminal-surface-replies.test-fixture')

type Runtime = ReturnType<typeof surfaceRuntime>['runtime']

it.each([
  [
    'with no window that never had one',
    (runtime: Runtime) => {
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    }
  ],
  [
    'with a window, under the same rule (L250)',
    (runtime: Runtime) => {
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    }
  ],
  [
    'with no window after its window closed',
    (runtime: Runtime) => {
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.markGraphUnavailable(1)
    }
  ]
])('creates a terminal on a host %s, and answers with its live handle', async (_name, setup) => {
  const { runtime, bindPane } = surfaceRuntime()
  setup(runtime)
  runtime.setPtyController({
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

  const unsubscribe = runtime.onMobileSessionTabsChanged(() => {}, 'phone')
  const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
    activate: false,
    select: false,
    navigation: 'caller',
    clientNavigationId: 'phone'
  })

  unsubscribe()
  expect(created.tab).toMatchObject({
    status: 'ready',
    terminal: expect.stringMatching(/^term_/)
  })
  if (!created.tab.terminal) {
    throw new Error('expected a terminal handle')
  }
  await expect(runtime.showTerminal(created.tab.terminal)).resolves.toMatchObject({
    ptyId: 'pty-new'
  })
})
