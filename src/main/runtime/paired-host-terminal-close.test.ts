// STA-7826: a CLI close of a terminal a paired runtime runs must reach that runtime, the only
// machine that can stop its process, instead of "stopping" the remote id on this machine.
import { describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../shared/remote-runtime-pty-id'
import { OrchestrationError } from './orchestration/orchestration-error'
import { getDefaultWorkspaceSession } from '../../shared/constants'

const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, makeRuntimeStoreWithWorkspaceSession } =
  await import('./orca-runtime-test-fixtures.spec')

const WORKTREE_ID = 'repo-1::/tmp/worktree-a'

type HostCall = (environmentId: string, method: string, params: unknown) => Promise<unknown>

function pairedHostLeafRuntime(hostCall: HostCall, runtimeStore: typeof store = store) {
  const runtime = new OrcaRuntimeService(runtimeStore)
  const localStops: string[] = []
  runtime.setPtyController({
    write: () => true,
    kill: (ptyId) => {
      localStops.push(ptyId)
      return false
    },
    stopAndWait: async (ptyId) => {
      localStops.push(ptyId)
      return false
    },
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  const closeTerminalTab = vi.fn(async () => {})
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    closeTerminalTab,
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  const call = vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(hostCall)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'Shell',
        activeLeafId: 'pane:1',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        leafId: 'pane:1',
        paneRuntimeId: 1,
        ptyId: toRemoteRuntimePtyId('term_on_host', 'env-1')
      }
    ]
  })
  return { runtime, call, closeTerminalTab, localStops }
}

async function listedHandle(runtime: InstanceType<typeof OrcaRuntimeService>): Promise<string> {
  const [terminal] = (await runtime.listTerminals()).terminals
  expect(terminal?.executionHostId).toBe('runtime:env-1')
  return terminal!.handle
}

describe('closing a terminal that a paired runtime runs', () => {
  it("returns the owning host's stop receipt and retires the local mirror", async () => {
    const { runtime, call, closeTerminalTab, localStops } = pairedHostLeafRuntime(async () => ({
      close: { handle: 'term_on_host', tabId: 'host-tab', ptyKilled: true }
    }))
    const handle = await listedHandle(runtime)

    await expect(runtime.closeTerminal(handle)).resolves.toEqual({
      handle,
      tabId: 'tab-1',
      ptyKilled: true
    })

    expect(call).toHaveBeenCalledWith(
      'env-1',
      'terminal.close',
      { terminal: 'term_on_host' },
      expect.any(Number)
    )
    expect(closeTerminalTab).toHaveBeenCalledWith('tab-1', {
      localPtyTeardownOwnedExternally: true
    })
    // This machine cannot stop the paired host's process, so it must not pretend to.
    expect(localStops).toEqual([])
  })

  it("keeps the host's unconfirmed-stop verdict instead of minting its own", async () => {
    const { runtime } = pairedHostLeafRuntime(async () => ({
      close: {
        handle: 'term_on_host',
        tabId: 'host-tab',
        ptyKilled: false,
        ptyStopVerdict: 'unverifiable',
        ptyStopReason: 'its SSH host could not be reached',
        pendingKillRecorded: true
      }
    }))
    const handle = await listedHandle(runtime)

    await expect(runtime.closeTerminal(handle)).resolves.toEqual({
      handle,
      tabId: 'tab-1',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'its SSH host could not be reached',
      pendingKillRecorded: true
    })
  })

  it('leaves the terminal in place when the owning host cannot be reached', async () => {
    const { runtime, closeTerminalTab, localStops } = pairedHostLeafRuntime(async () => {
      throw new Error('connect ETIMEDOUT')
    })
    const handle = await listedHandle(runtime)

    await expect(runtime.closeTerminal(handle)).rejects.toThrow('connect ETIMEDOUT')

    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(localStops).toEqual([])
    expect((await runtime.listTerminals()).terminals.map((terminal) => terminal.handle)).toEqual([
      handle
    ])
  })

  it('retires the mirror of a terminal the owning host no longer knows, without claiming a stop', async () => {
    // The owner is a real runtime that never issued this handle; the RPC layer passes its
    // refusal code through, as `mapRuntimeError` does for `terminal_handle_stale`.
    const owner = new OrcaRuntimeService(store)
    owner.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { runtime, closeTerminalTab } = pairedHostLeafRuntime(async (_env, _method, params) => {
      const terminal =
        typeof params === 'object' && params !== null && 'terminal' in params
          ? String(params.terminal)
          : ''
      try {
        return { close: await owner.closeTerminal(terminal) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new OrchestrationError(message, message)
      }
    })
    const handle = await listedHandle(runtime)

    await expect(runtime.closeTerminal(handle)).resolves.toEqual({
      handle,
      tabId: 'tab-1',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'its owning host no longer recognizes this terminal handle'
    })
    expect(closeTerminalTab).toHaveBeenCalledOnce()
  })

  it.each(['local', 'runtime:env-1'] as const)(
    'refuses a pinned tab saved in the %s partition before the owning host stops anything',
    async (partition) => {
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
        {
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: {
            [WORKTREE_ID]: [
              {
                id: 'tab-1',
                ptyId: toRemoteRuntimePtyId('term_on_host', 'env-1'),
                worktreeId: WORKTREE_ID,
                title: 'Shell',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 0,
                isPinned: true
              }
            ]
          }
        },
        partition
      )
      const { runtime, call } = pairedHostLeafRuntime(
        async () => ({ close: { handle: 'term_on_host', tabId: 'host-tab', ptyKilled: true } }),
        runtimeStore
      )
      const handle = await listedHandle(runtime)

      await expect(runtime.closeTerminal(handle)).rejects.toThrow('terminal_tab_pinned')
      await expect(runtime.closeTerminalTab(handle)).rejects.toThrow('terminal_tab_pinned')
      expect(call).not.toHaveBeenCalled()
    }
  )

  it('leaves a pane rebound during the host call to its new occupant', async () => {
    let answerHost: ((value: unknown) => void) | null = null
    const { runtime, closeTerminalTab } = pairedHostLeafRuntime(
      () =>
        new Promise((resolve) => {
          answerHost = resolve
        })
    )
    const handle = await listedHandle(runtime)

    const closing = runtime.closeTerminal(handle)
    await vi.waitFor(() => expect(answerHost).not.toBeNull())
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          title: 'Shell',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: toRemoteRuntimePtyId('term_replacement', 'env-1')
        }
      ]
    })
    answerHost!({ close: { handle: 'term_on_host', tabId: 'host-tab', ptyKilled: true } })

    await expect(closing).resolves.toEqual({ handle, tabId: 'tab-1', ptyKilled: true })
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })

  it('routes a whole-tab close to the owning host too', async () => {
    const { runtime, call } = pairedHostLeafRuntime(async () => ({
      close: { handle: 'term_on_host', tabId: 'host-tab', closeMode: 'tab', ptyKilled: false }
    }))
    const handle = await listedHandle(runtime)

    // This harness publishes no session snapshot, so the local tab commit after it answers
    // tab_not_found; the host close must already have been sent.
    await runtime.closeTerminalTab(handle).catch(() => undefined)
    expect(call).toHaveBeenCalledWith(
      'env-1',
      'terminal.closeTab',
      { terminal: 'term_on_host' },
      expect.any(Number)
    )
  })
})
