import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('orchestration federated worker output', () => {
  const databases: OrchestrationDb[] = []
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let workerSupportsStructuredRead: boolean

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    databases.push(homeDb, workerDb)
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })
    workerSupportsStructuredRead = true
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
        if (method === 'orchestration.federationReadOutput' && !workerSupportsStructuredRead) {
          return {
            id: `remote_${method}`,
            ok: false,
            error: { code: 'method_not_found', message: `Unknown method: ${method}` }
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
    homeDispatcher = new RpcDispatcher({
      runtime: homeRuntime,
      methods: ORCHESTRATION_METHODS
    })
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null
    )
    configureWorkerRuntime(workerRuntime)
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  function createHomeTask() {
    const run = homeDb.createRun({
      objective: 'Mac to Windows output',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    return homeDb.createTask({ spec: 'Read Windows worker output', runId: run.id })
  }

  function startRequest(taskId: string): RpcRequest {
    return {
      id: 'rpc_worker_start',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_windows_worker',
      method: 'orchestration.workerStart',
      params: {
        task: taskId,
        from: 'term_coord',
        on: 'windows',
        worktree: 'new-top-level',
        repo: 'id:windows-repo',
        name: 'windows-output',
        agent: 'codex'
      }
    }
  }

  function configureWorkerRuntime(runtime: OrcaRuntimeService): void {
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'windows-repo',
      kind: 'git'
    } as never)
    vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
      worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_windows_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_configured'
      }
    } as never)
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [{ handle: 'term_windows_worker', title: 'Codex' }],
      totalCount: 1,
      truncated: false
    } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
      'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('windows_runtime:pty:1')
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_windows_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      worktreeId: 'repo::windows-worktree',
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      status: 'running',
      tail: ['remote output'],
      truncated: false,
      nextCursor: '1'
    })
  }

  async function startRemoteWorker(): Promise<string> {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    return homeDb.getDispatchContext(task.id)!.id
  }

  it('routes show and read by Dispatch without repeating the worker server', async () => {
    const dispatchId = await startRemoteWorker()

    const shown = await homeDispatcher.dispatch({
      id: 'rpc_remote_show',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatchId }
    })
    const read = await homeDispatcher.dispatch({
      id: 'rpc_remote_read',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId, limit: 20 }
    })

    expect(shown).toMatchObject({
      ok: true,
      result: {
        server: { environmentId: 'environment_windows', name: 'windows' },
        observation: { status: 'live', exactWorker: true },
        terminal: { handle: 'term_windows_worker' }
      }
    })
    expect(read).toMatchObject({
      ok: true,
      result: {
        source: 'terminal',
        fallbackReason: 'session_not_reported',
        server: { environmentId: 'environment_windows', name: 'windows' },
        terminal: { tail: ['remote output'] }
      }
    })
  })

  it('keeps an opaque terminal cursor across mixed server versions', async () => {
    const dispatchId = await startRemoteWorker()
    workerSupportsStructuredRead = false

    const automatic = await homeDispatcher.dispatch({
      id: 'rpc_remote_legacy_read',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId }
    })
    const cursor = (automatic as { result: { cursor: string } }).result.cursor
    const continued = await homeDispatcher.dispatch({
      id: 'rpc_remote_legacy_continue',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId, cursor }
    })
    const required = await homeDispatcher.dispatch({
      id: 'rpc_remote_legacy_transcript',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId, source: 'transcript' }
    })

    expect(automatic).toMatchObject({
      ok: true,
      result: {
        source: 'terminal',
        fallbackReason: 'remote_capability_unavailable',
        terminal: { tail: ['remote output'] }
      }
    })
    expect(cursor).toMatch(/^owr1_/)
    expect(continued).toMatchObject({
      ok: true,
      result: {
        source: 'terminal',
        fallbackReason: 'remote_capability_unavailable'
      }
    })
    expect((continued as { result: { cursor: string } }).result.cursor).toMatch(/^owr1_/)
    expect(required).toMatchObject({
      ok: false,
      error: {
        code: 'transcript_required',
        data: { reason: 'remote_capability_unavailable' }
      }
    })
  })

  it('reads the exact transcript on the worker server without leaking its path home', async () => {
    const dispatchId = await startRemoteWorker()
    const directory = await mkdtemp(join(tmpdir(), 'orca-federated-worker-output-'))
    const transcriptPath = join(directory, 'windows-session.jsonl')
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'event_msg',
        payload: { id: 'remote-message', type: 'agent_message', message: 'Windows result' }
      })}\n`
    )
    vi.spyOn(workerRuntime, 'getExactWorkerProviderSession').mockReturnValue({
      paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'windows_runtime:pty:1',
      agent: 'codex',
      providerSession: {
        key: 'session_id',
        id: 'windows-session',
        transcriptPath
      },
      observedAt: Date.now()
    })

    try {
      const response = await homeDispatcher.dispatch({
        id: 'rpc_remote_transcript_read',
        authToken: 'coordinator-token',
        method: 'orchestration.workerRead',
        params: { dispatch: dispatchId }
      })

      expect(response).toMatchObject({
        ok: true,
        result: {
          source: 'transcript',
          provider: 'codex',
          server: { environmentId: 'environment_windows' },
          transcript: {
            messages: [
              {
                id: 'remote-message',
                blocks: [{ type: 'text', text: 'Windows result' }]
              }
            ]
          }
        }
      })
      expect(JSON.stringify(response)).not.toContain(transcriptPath)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
