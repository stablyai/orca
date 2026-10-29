// Layout-owner builds bind a terminal's pane before registering it (L80), so main's layout answers
// which pane holds the terminal from its first registration.
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-types'
import type { RuntimeStore } from '../../runtime-store-contract'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
await import('../../orca-runtime-test-mocks.spec')
await import('../../orca-runtime-test-lifecycle.spec')
const { TEST_WORKTREE_ID, TEST_WORKTREE_PATH } =
  await import('../../orca-runtime-test-fixtures.spec')
const { surfaceRuntime } = await import('../surface/terminal-surface-replies.test-fixture')
const { spawnInAdmittedPane } = await import('../../runtime-pane-admission')
const { leaveSpawnsUncommitted } = await import('../../bind-first-pane.test-fixture')
const { PaneStartStatuses } = await import('../../pane-start-statuses')
const { bindingOf } = await import('../../pane-live-facts')

type SpawnArgs = { worktreeId?: string; tabId?: string; leafId?: string }

function createOn(bindsFirst: boolean) {
  const { runtime, bindPane, store } = surfaceRuntime()
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  // The terminal main's layout binds the registering pane to, read as registration starts.
  const answeredAtRegistration: (string | null)[] = []
  const register = runtime.registerPty.bind(runtime)
  runtime.registerPty = (ptyId, worktreeId, connectionId, binding) => {
    if (binding) {
      const layout = store.getSession().terminalLayoutsByTabId[binding.tabId]
      answeredAtRegistration.push(layout?.ptyIdsByLeafId?.[binding.leafId] ?? null)
    }
    return register(ptyId, worktreeId, connectionId, binding)
  }
  const controller = {
    spawn: vi.fn(async (args: SpawnArgs) => {
      if (bindsFirst) {
        // As the PTY host's spawn commit: it binds the pane before the spawn answers.
        await bindPane({
          worktreeId: args.worktreeId!,
          tabId: args.tabId!,
          leafId: args.leafId!,
          ptyId: 'pty-new'
        })
      }
      return { id: 'pty-new' }
    }),
    write: () => true,
    kill: () => true,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () =>
      ['pty-a', 'pty-b', 'pty-new'].map((id) => ({ id, cwd: TEST_WORKTREE_PATH, title: 'sh' }))
  }
  // The suites' stand-in spawn commit binds first; this test drives a spawn that does not.
  runtime.setPtyController(bindsFirst ? controller : leaveSpawnsUncommitted(controller))
  return { runtime, answeredAtRegistration }
}

function createFromPhone(runtime: ReturnType<typeof createOn>['runtime']) {
  return runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
    activate: false,
    select: false,
    navigation: 'caller',
    clientNavigationId: 'phone'
  })
}

describe('bind-first registration (switch on)', () => {
  it('registers a created terminal only once main’s layout binds its pane', async () => {
    const { runtime, answeredAtRegistration } = createOn(true)

    const created = await createFromPhone(runtime)

    expect(answeredAtRegistration.length).toBeGreaterThan(0)
    expect(answeredAtRegistration).toEqual(answeredAtRegistration.map(() => 'pty-new'))
    expect(created.tab).toMatchObject({ status: 'ready' })
  })

  it('refuses, in tests, a path that registers before the binding write', async () => {
    const { runtime } = createOn(false)

    await expect(createFromPhone(runtime)).rejects.toThrow('pane_unbound_at_registration')
  })

  it('shows the failure on a pane whose start died between the pane write and the binding write', async () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const store = {
      admitTerminalPane: vi.fn(async () => 'admitted' as const),
      withdrawTerminalPane: vi.fn(async () => null),
      getWorkspaceSession: vi.fn(() => ({
        terminalLayoutsByTabId: {
          'tab-1': { root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' } }
        }
      }))
    }
    const statuses = new PaneStartStatuses(vi.fn())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission path calls only these three store methods.
    const runtimeStore = store as unknown as RuntimeStore

    await expect(
      spawnInAdmittedPane(
        runtimeStore,
        {
          // The process started, then its commit could not write the binding and took it back.
          spawn: vi.fn(async () => {
            throw new Error('terminal session state could not be saved')
          })
        },
        {
          cols: 80,
          rows: 24,
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId: '11111111-1111-4111-8111-111111111111',
          startStatus: { sink: statuses, keepOnFailure: true }
        }
      )
    ).rejects.toThrow('could not be saved')

    // The pane stays, bound to nothing, and says why it has no terminal.
    expect(store.withdrawTerminalPane).not.toHaveBeenCalled()
    expect(statuses.get(paneKey, bindingOf({}))).toEqual({
      status: 'failed',
      reason: 'terminal session state could not be saved'
    })
  })
})
