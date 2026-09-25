import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'
import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from './orca-runtime-test-fixtures.spec'

const TAB_ID = 'host-tab'
const RELAY_PTY_ID = 'ssh:ssh-1@@relay-pty'
const INCARNATION_ID = 'inc-1'

/**
 * A runtime that restarted while its SSH pane survived: the persisted session still
 * names the pane's PTY and the provider inventory still lists it, but this runtime
 * generation has never attached to it.
 */
function makeRestartedRuntime(opts: { publishedByRenderer?: boolean } = {}): {
  runtime: OrcaRuntimeService
  spawn: ReturnType<typeof vi.fn>
} {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: TAB_ID,
            ptyId: RELAY_PTY_ID,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Remote Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        [TAB_ID]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: RELAY_PTY_ID })
      },
      terminalPtyIncarnationsByPaneKey: {
        [makePaneKey(TAB_ID, HEADLESS_LEAF_ID)]: INCARNATION_ID
      }
    }),
    'ssh:ssh-1'
  )
  const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
  const spawn = vi.fn().mockResolvedValue({ id: RELAY_PTY_ID, isReattach: true })
  const runtime = new OrcaRuntimeService({
    ...runtimeStore,
    getRepos: () => [remoteRepo],
    getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
  } as never)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    // The surviving pane is still in the provider's session map after the restart.
    listProcesses: async () => [
      {
        id: RELAY_PTY_ID,
        worktreeId: TEST_WORKTREE_ID,
        cwd: TEST_WORKTREE_PATH,
        incarnationId: INCARNATION_ID,
        title: 'Remote Terminal'
      }
    ]
  } as never)
  if (opts.publishedByRenderer) {
    // A desktop-created SSH terminal: the renderer graph lists the tab, so this
    // runtime is not the only thing that could be attached to the session.
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Remote Terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: RELAY_PTY_ID,
          paneTitle: null
        }
      ]
    } as never)
  } else {
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] } as never)
  }
  return { runtime, spawn }
}

function restoredPty(
  runtime: OrcaRuntimeService
): { connected: boolean; runtimeSessionOwned: boolean } | undefined {
  return (
    runtime as unknown as {
      ptysById: Map<string, { connected: boolean; runtimeSessionOwned: boolean }>
    }
  ).ptysById.get(RELAY_PTY_ID)
}

describe('restored runtime-owned terminal reattachment', () => {
  it('records an inventory-restored PTY as connected without owning it', async () => {
    const { runtime } = makeRestartedRuntime()

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    // Inventory presence alone makes the tab look usable to the client.
    expect(result.tabs[0]).toMatchObject({ status: 'ready' })
    expect(restoredPty(runtime)).toMatchObject({ connected: true, runtimeSessionOwned: false })
  })

  it('reattaches the restored session on activation instead of trusting inventory', async () => {
    const { runtime, spawn } = makeRestartedRuntime()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID)

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        tabId: TAB_ID,
        leafId: HEADLESS_LEAF_ID,
        sessionId: RELAY_PTY_ID
      })
    )
  })

  it('reattaches once, not on every activation', async () => {
    const { runtime, spawn } = makeRestartedRuntime()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID)
    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID)

    expect(spawn).toHaveBeenCalledOnce()
  })

  it('focuses a renderer-published SSH tab instead of reattaching it', async () => {
    const { runtime, spawn } = makeRestartedRuntime({ publishedByRenderer: true })
    const focusTerminal = vi.fn()
    runtime.setNotifier({ focusTerminal } as never)
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID)

    // The renderer graph lists this tab, so the desktop is already attached.
    // Reattaching would take a live session away from it.
    expect(spawn).not.toHaveBeenCalled()
    expect(focusTerminal).toHaveBeenCalled()
  })

  it('leaves an inventory-restored local tab alone', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        terminalPtyIncarnationsByPaneKey: {
          [makePaneKey(TAB_ID, HEADLESS_LEAF_ID)]: INCARNATION_ID
        }
      })
    )
    const spawn = vi.fn().mockResolvedValue({ id: 'persisted-pty' })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'persisted-pty',
          worktreeId: TEST_WORKTREE_ID,
          cwd: TEST_WORKTREE_PATH,
          incarnationId: INCARNATION_ID
        }
      ]
    } as never)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] } as never)
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs[0]).toMatchObject({ status: 'ready' })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID)

    // A plain local PTY is renderer-owned; inventory presence must not respawn it.
    expect(spawn).not.toHaveBeenCalled()
  })
})
