// Layout-owner build: a paired desktop's Reopen of a pane main holds for a newer build's terminal
// service stops that service, then starts the pane; its published status clears as it binds.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NEWER_DAEMON_HOLD_ERROR } from '../../shared/newer-daemon-hold'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type * as DaemonHoldModule from '../daemon/daemon-newer-protocol-hold'
import { committingSpawn } from './bind-first-pane.test-fixture'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
const daemonHold = vi.hoisted(() => ({ reopen: vi.fn() }))
vi.mock('../daemon/daemon-newer-protocol-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonHoldModule>()),
  reopenNewerDaemonTerminals: daemonHold.reopen
}))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const PANE = { worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }

/** A windowless host whose first start of the pane is held for a newer build. */
async function heldPaneRuntime() {
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(
    Object.assign(runtimeStore, {
      getWorkspaceSessionHostIds: (): ExecutionHostId[] => [LOCAL_EXECUTION_HOST_ID]
    })
  )
  // A paired desktop's layout stream: what main publishes is what it reads.
  const desktopStream = runtime.subscribeWorkspaceLayouts(() => {})
  const spawn = vi.fn(
    committingSpawn(
      runtime,
      async (_args: {
        sessionId?: string
        worktreeId?: string
        tabId?: string
        leafId?: string
      }) => ({
        id: 'pty-reopened'
      })
    )
  )
  spawn.mockRejectedValueOnce(new Error(NEWER_DAEMON_HOLD_ERROR))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  await expect(runtime.ensureRestoredPaneStarted(PANE)).rejects.toThrow(NEWER_DAEMON_HOLD_ERROR)
  return { runtime, spawn, getSession, setSession, desktopStream }
}

/** The pane's start status as main publishes it to a paired desktop. */
function publishedStatus(runtime: InstanceType<typeof OrcaRuntimeService>) {
  const { snapshot, unsubscribe } = runtime.subscribeWorkspaceLayouts(() => {})
  unsubscribe()
  return snapshot
    .find((entry) => entry.key === TEST_WORKTREE_ID)
    ?.layout.tabs.flatMap((tab) => tab.terminal?.panes ?? [])
    .find((pane) => pane.leafId === HEADLESS_LEAF_ID)?.status
}

beforeEach(() => {
  daemonHold.reopen.mockReset()
  daemonHold.reopen.mockResolvedValue({ reopened: true })
})

describe("a paired desktop's Reopen of a held pane (layout-owner build)", () => {
  it('stops the newer build, then starts the pane, whose held status clears', async () => {
    const { runtime, spawn } = await heldPaneRuntime()
    expect(publishedStatus(runtime)).toBe('held')

    await expect(runtime.reopenHeldTerminalPanes([PANE])).resolves.toEqual({ reopened: true })

    expect(daemonHold.reopen).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'persisted-pty' }))
    expect(publishedStatus(runtime)).toBeUndefined()
  })

  it('starts nothing and stays held while the newer build may still run', async () => {
    const { runtime, spawn } = await heldPaneRuntime()
    daemonHold.reopen.mockResolvedValue({ reopened: false })

    await expect(runtime.reopenHeldTerminalPanes([PANE])).resolves.toEqual({ reopened: false })

    expect(spawn).toHaveBeenCalledOnce()
    expect(publishedStatus(runtime)).toBe('held')
  })

  it('stops nothing for a pane since bound to a new terminal, though its held entry stays', async () => {
    const { runtime, spawn, getSession, setSession, desktopStream } = await heldPaneRuntime()
    expect(publishedStatus(runtime)).toBe('held')
    const session = getSession()
    const layout = session.terminalLayoutsByTabId[PANE.tabId]!
    setSession({
      ...session,
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [PANE.tabId]: {
          ...layout,
          ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [PANE.leafId]: 'pty-rebound' }
        }
      }
    })
    // The stream re-projects from the rebound session, as a write notification would make it.
    desktopStream.unsubscribe()

    await expect(runtime.reopenHeldTerminalPanes([PANE])).resolves.toEqual({ reopened: true })

    expect(daemonHold.reopen).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('stops nothing for a pane main does not hold', async () => {
    const { runtime, spawn } = await heldPaneRuntime()

    await expect(
      runtime.reopenHeldTerminalPanes([{ ...PANE, tabId: 'other-tab' }])
    ).resolves.toEqual({ reopened: true })

    expect(daemonHold.reopen).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledOnce()
  })
})
