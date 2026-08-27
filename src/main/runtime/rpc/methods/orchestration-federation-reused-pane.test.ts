import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createFederationWorkerStartRequest as startRequest } from './orchestration-federation-test-request'

describe('orchestration federation reused panes', () => {
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: 'windows_peer_fingerprint'
      }),
      call: async (_selector, method, params, _timeoutMs, envelope) => {
        if (method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: workerRuntime.getStatus(),
            _meta: { runtimeId: workerRuntime.getRuntimeId() }
          }
        }
        return (await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId,
          orchestrationCapability: envelope?.orchestrationCapability
        })) as RuntimeRpcResponse<unknown>
      }
    }
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    homeDispatcher = new RpcDispatcher({ runtime: homeRuntime, methods: ORCHESTRATION_METHODS })
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockReturnValue(
      'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    vi.spyOn(workerRuntime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(workerRuntime, 'getTerminalPaneKey').mockReturnValue(
      'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.spyOn(workerRuntime, 'getTerminalProcessIncarnation').mockReturnValue(
      'windows_runtime:pty:1'
    )
    vi.spyOn(workerRuntime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(workerRuntime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(workerRuntime, 'showTerminal').mockImplementation(
      async (handle) =>
        ({ handle, worktreeId: 'repo::windows-worktree', status: 'running' }) as never
    )
    vi.spyOn(workerRuntime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_windows_worker',
      accepted: true,
      bytesWritten: 1
    })
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    homeDb.close()
    workerDb.close()
  })

  function createHomeTask() {
    const run = homeDb.createRun({
      objective: 'Mac to Windows',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    return homeDb.createTask({ spec: 'Audit Windows behavior', runId: run.id })
  }

  function stubRemoteWorktree(): void {
    vi.spyOn(workerRuntime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::windows-worktree',
      repoId: 'repo'
    } as never)
  }

  it('refreshes a reused remote pane foreground owner before dispatch input', async () => {
    stubRemoteWorktree()
    vi.spyOn(workerRuntime, 'isTerminalRunningAgent').mockResolvedValue(false)
    const refreshed = vi
      .spyOn(workerRuntime, 'refreshTerminalPromptAgentOwner')
      .mockResolvedValue('codex')
    const task = createHomeTask()

    const started = await homeDispatcher.dispatch(
      startRequest(task.id, {
        worktree: 'id:repo::windows-worktree',
        terminal: 'term_windows_worker',
        repo: undefined,
        name: undefined,
        agent: undefined
      })
    )

    expect(started).toMatchObject({ ok: true, result: { state: 'ready' } })
    expect(refreshed).toHaveBeenCalledWith('term_windows_worker')
    expect(workerRuntime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
  })

  it('waits for a reused remote wrapper to resolve its current foreground owner', async () => {
    stubRemoteWorktree()
    const internals = workerRuntime as unknown as {
      resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
    }
    vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: 'repo::windows-worktree',
      path: 'C:\\repo\\worktree',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    workerRuntime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty_windows_worker', incarnationId: 'inc_worker' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: vi.fn().mockResolvedValueOnce('node').mockResolvedValue('codex')
    })
    const terminal = await workerRuntime.createTerminal('id:repo::windows-worktree', {
      tabId: 'tab_worker',
      leafId: 'leaf_worker',
      title: 'worker'
    })
    workerRuntime.attachWindow(1)
    workerRuntime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab_worker',
          worktreeId: 'repo::windows-worktree',
          title: 'worker',
          activeLeafId: 'leaf_worker',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab_worker',
          worktreeId: 'repo::windows-worktree',
          leafId: 'leaf_worker',
          paneRuntimeId: 1,
          ptyId: 'pty_windows_worker',
          paneTitle: 'bash'
        }
      ]
    })
    const task = createHomeTask()

    const started = await homeDispatcher.dispatch(
      startRequest(task.id, {
        worktree: 'id:repo::windows-worktree',
        terminal: terminal.handle,
        repo: undefined,
        name: undefined,
        agent: undefined
      })
    )

    expect(started).toMatchObject({ ok: true, result: { state: 'ready' } })
    expect(workerRuntime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
  })
})
