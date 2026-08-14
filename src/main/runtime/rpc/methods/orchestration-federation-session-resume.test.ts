import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_WORKER_SESSION_RESUME_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { captureRemoteWorkerResumeCheckpoint } from '../../orchestration/worker-session-resume'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createFederationWorkerStartRequest } from './orchestration-federation-test-request'

describe('orchestration federated worker session resume', () => {
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let workerCapabilities: string[]

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    configureWorkerRuntime(workerRuntime)
    workerDispatcher = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
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
            result: { ...workerRuntime.getStatus(), capabilities: workerCapabilities },
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
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null
    )
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    homeDb.close()
    workerDb.close()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function createHomeTask() {
    const run = homeDb.createRun({
      objective: 'Resume Windows worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    return homeDb.createTask({ spec: 'Initial Windows task', runId: run.id })
  }

  async function startSource(taskId: string) {
    const started = await homeDispatcher.dispatch(createFederationWorkerStartRequest(taskId))
    if (!started.ok || (started.result as { state?: string }).state !== 'ready') {
      throw new Error(`Federated source did not start: ${JSON.stringify(started)}`)
    }
    return homeDb.getDispatchContext(taskId)!
  }

  async function completeSource(taskId: string, dispatchId: string) {
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    vi.spyOn(workerRuntime, 'getExactWorkerProviderSession').mockReturnValue({
      paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'windows_runtime:pty:1',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'remote-provider-secret' },
      observedAt: Date.now()
    })
    vi.spyOn(workerRuntime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      terminalHandle: 'term_windows_worker',
      paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'windows_runtime:pty:1',
      worktreeId: 'repo::windows-worktree',
      hostScope: { kind: 'local', hostId: 'local' }
    } as never)
    return workerDispatcher.dispatch({
      id: 'rpc_resume_source_done',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'resume_source_done_request',
      orchestrationCapability: capability,
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Source complete',
        body: 'Source finished. Resume state is durable. Nothing remains.',
        type: 'worker_done',
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
      }
    })
  }

  it('resumes a settled worker on the owning server and worktree', async () => {
    const task = createHomeTask()
    const source = await startSource(task.id)
    await expect(completeSource(task.id, source.id)).resolves.toMatchObject({
      ok: true,
      result: { resumeCheckpoint: 'captured' }
    })
    const followUp = homeDb.createTask({ spec: 'Continue remotely', runId: task.run_id })
    vi.spyOn(workerRuntime, 'isTerminalRunningAgent').mockResolvedValue(false)
    const ensure = vi.spyOn(workerRuntime, 'ensureAgentSession').mockResolvedValue({
      terminal: {
        handle: 'term_windows_resumed',
        worktreeId: 'repo::windows-worktree',
        title: 'Codex'
      },
      disposition: 'created'
    } as never)
    vi.mocked(workerRuntime.getTerminalPaneKey).mockReturnValue(
      'tab_resumed:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    )
    vi.mocked(workerRuntime.getTerminalProcessIncarnation).mockReturnValue('windows_runtime:pty:2')
    vi.mocked(workerRuntime.getOrchestrationDispatchAuthority).mockReturnValue({
      terminalHandle: 'term_windows_resumed',
      paneKey: 'tab_resumed:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      processIncarnation: 'windows_runtime:pty:2',
      worktreeId: 'repo::windows-worktree',
      hostScope: { kind: 'local', hostId: 'local' }
    } as never)
    vi.mocked(workerRuntime.showTerminal).mockResolvedValue({
      handle: 'term_windows_resumed',
      worktreeId: 'repo::windows-worktree',
      status: 'running'
    } as never)

    const resumed = await homeDispatcher.dispatch(resumeRequest(followUp.id, source.id))

    expect(resumed).toMatchObject({ ok: true, result: { state: 'ready' } })
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree: 'id:repo::windows-worktree',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'remote-provider-secret' }
      })
    )
    expect(workerRuntime.createManagedWorktree).toHaveBeenCalledOnce()
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls.at(-1)?.[1]
    expect(prompt).toContain('NATIVE SESSION RESUME BOUNDARY')
    expect(prompt).not.toContain('remote-provider-secret')
  })

  it('rejects mixed-version resume before remote attachment', async () => {
    const task = createHomeTask()
    const source = await startSource(task.id)
    homeDb.settleWorkerReport({
      taskId: task.id,
      dispatchId: source.id,
      outcome: 'succeeded',
      result: 'done'
    })
    const followUp = homeDb.createTask({ spec: 'Continue remotely', runId: task.run_id })
    workerCapabilities = workerCapabilities.filter(
      (capability) => capability !== ORCHESTRATION_WORKER_SESSION_RESUME_RUNTIME_CAPABILITY
    )

    const resumed = await homeDispatcher.dispatch(resumeRequest(followUp.id, source.id))

    expect(resumed).toMatchObject({
      ok: false,
      error: { code: 'capability_unsupported' }
    })
    expect(
      workerDb.getRemoteDispatchAttachment(homeDb.getDispatchContext(followUp.id)?.id ?? '')
    ).toBeUndefined()
  })

  it('observes remote provider sessions after the attachment UTC timestamp', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    const dispatchId = 'ctx_remote_resume_ts'
    const createdAt = '2026-08-13 12:00:00'
    workerDb.createRemoteDispatchAttachment({
      dispatchId,
      taskId: 'task_remote_resume_ts',
      homePeerFingerprint: 'windows_peer_fingerprint',
      protocolVersion: 3,
      runtimeEpoch: workerRuntime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'windows_peer_fingerprint',
        requestId: 'remote_resume_ts_request',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'remote_resume_ts_hash'
      }
    })
    const sqlite = (
      workerDb as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }
      }
    ).db
    sqlite
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET terminal_handle = ?, worktree_id = ?, process_incarnation = ?, created_at = ?
         WHERE dispatch_id = ?`
      )
      .run(
        'term_windows_worker',
        'repo::windows-worktree',
        'windows_runtime:pty:1',
        createdAt,
        dispatchId
      )
    const observedAfter: number[] = []
    vi.spyOn(workerRuntime, 'getExactWorkerProviderSession').mockImplementation(
      (_handle, after) => {
        observedAfter.push(after)
        return {
          paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          processIncarnation: 'windows_runtime:pty:1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'remote-provider-secret' },
          observedAt: Date.now()
        }
      }
    )
    vi.spyOn(workerRuntime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      terminalHandle: 'term_windows_worker',
      paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'windows_runtime:pty:1',
      worktreeId: 'repo::windows-worktree',
      hostScope: { kind: 'local', hostId: 'local' }
    } as never)

    expect(
      captureRemoteWorkerResumeCheckpoint({
        runtime: workerRuntime,
        db: workerDb,
        dispatchId
      })
    ).toBe('captured')

    const utcObservedAfter = Date.parse('2026-08-13T12:00:00Z')
    expect(observedAfter).toEqual([utcObservedAfter])
    const localObservedAfter = Date.parse(createdAt)
    expect(localObservedAfter).not.toBe(utcObservedAfter)
    expect(observedAfter[0]).not.toBe(localObservedAfter)
  })
})

function resumeRequest(taskId: string, sourceDispatchId: string) {
  return {
    id: `rpc_resume_${taskId}`,
    authToken: 'coordinator-token',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `request_resume_${taskId}`,
    method: 'orchestration.workerStart',
    params: { task: taskId, from: 'term_coord', resumeDispatch: sourceDispatchId }
  }
}

function configureWorkerRuntime(runtime: OrcaRuntimeService): void {
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'windows-repo', kind: 'git' } as never)
  vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
    worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
    startupTerminal: { spawned: true, handle: 'term_windows_worker' },
    setupReceipt: {
      requested: 'run',
      hookFound: true,
      startupPolicy: 'start-immediately',
      state: 'running'
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
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'repo::windows-worktree'
  } as never)
  vi.spyOn(runtime, 'getOrchestrationWorkspaceHostScope').mockResolvedValue({
    kind: 'local',
    hostId: 'local'
  })
}
