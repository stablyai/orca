import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import { OrchestrationDb as OrchestrationDbClass } from '../../orchestration/db'
import { OrcaRuntimeService as OrcaRuntimeServiceClass } from '../../orca-runtime'
import { ORCHESTRATION_METHODS } from './orchestration'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { TERMINAL_INPUT_TOO_LARGE_ERROR } from '../../../../shared/terminal-input'
import { dispatchInputFailedEffect } from './orchestration-dispatch-input-verdict'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'

type DispatchInputEffectRow = {
  kind: string
  role?: string
  id?: string
  state?: string
  cause?: string
  detail?: string
}

describe('dispatch input verdict', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  function mockWorkerStart(): void {
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_worker'
          ? 'tab_worker:leaf_worker'
          : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({ id: 'repo::worktree' } as never)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  }

  async function startWorkerWithPromptError(error: Error) {
    ;({ db, runtime, ctx } = h.setup())
    mockWorkerStart()
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockRejectedValue(error)
    const task = db.createTask({ spec: 'worker whose preamble never submits' })
    const result = (await h.call(
      'orchestration.workerStart',
      { task: task.id, from: 'term_coord', agent: 'codex' },
      ctx
    )) as { dispatchId: string; state: string; failedStage: string; effects: unknown[] }
    return result
  }

  function readPersistedDispatchInput(dispatchId: string): DispatchInputEffectRow | undefined {
    const stored = JSON.parse(
      db.getWorkerDispatch(dispatchId)?.effects ?? '[]'
    ) as DispatchInputEffectRow[]
    return stored.find((effect) => effect.kind === 'dispatch_input')
  }

  it('keeps a stalled submission on the Dispatch instead of only throwing', async () => {
    const result = await startWorkerWithPromptError(new Error('agent_prompt_stalled'))

    expect(result.state).toBe('failed')
    expect(result.failedStage).toBe('dispatch_input')
    expect(readPersistedDispatchInput(result.dispatchId)).toEqual({
      kind: 'dispatch_input',
      role: 'agent',
      id: 'term_worker',
      state: 'failed',
      cause: 'agent_prompt_stalled',
      detail: 'agent_prompt_stalled'
    })
  })

  it('separates a blocked submission from a never-attempted one', async () => {
    const blocked = await startWorkerWithPromptError(new Error('agent_prompt_blocked'))
    expect(readPersistedDispatchInput(blocked.dispatchId)?.cause).toBe('agent_prompt_blocked')

    h.cleanup()
    ;({ db, runtime, ctx } = h.setup())
    mockWorkerStart()
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null
    })
    const task = db.createTask({ spec: 'worker that never reached the preamble' })
    const neverAttempted = (await h.call(
      'orchestration.workerStart',
      { task: task.id, from: 'term_coord', agent: 'codex' },
      ctx
    )) as { dispatchId: string; failedStage: string }

    expect(neverAttempted.failedStage).toBe('agent_readiness')
    expect(readPersistedDispatchInput(neverAttempted.dispatchId)).toBeUndefined()
  })

  it('classifies a stale handle and keeps unrecognized causes readable', () => {
    expect(dispatchInputFailedEffect('term_worker', new Error('terminal_handle_stale'))).toEqual({
      kind: 'dispatch_input',
      role: 'agent',
      id: 'term_worker',
      state: 'failed',
      cause: 'terminal_handle_stale',
      detail: 'terminal_handle_stale'
    })
    expect(dispatchInputFailedEffect('term_worker', new Error('EPIPE write failed'))).toMatchObject(
      {
        cause: 'unknown',
        detail: 'EPIPE write failed'
      }
    )
  })
})

// Why: the federated attach runs the same preamble submission on the remote
// host, where the exception never crosses back to the Run home at all.
describe('federated dispatch input verdict', () => {
  let db: OrchestrationDbClass | undefined

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('keeps the blocked cause on the remote attachment', async () => {
    db = new OrchestrationDbClass(':memory:')
    const runtime = new OrcaRuntimeServiceClass()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder:remote-workspace'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      worktreeId: 'folder:remote-workspace',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_remote:leaf_remote')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
      'runtime_test:term_remote_worker:1'
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockRejectedValue(
      new Error('agent_prompt_blocked')
    )
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }

    const result = (await method.handler(
      method.params!.parse({
        dispatchId: 'ctx_remote',
        taskId: 'task_remote',
        taskSpec: 'remote worker whose preamble never submits',
        protocolVersion: 3,
        worktree: 'folder:remote-workspace',
        agent: 'codex'
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_peer',
          requestId: 'request_remote',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'remote_payload'
        }
      }
    )) as { state: string; failedStage: string }

    expect(result).toMatchObject({ state: 'failed', failedStage: 'dispatch_input' })
    const stored = JSON.parse(
      db.getRemoteDispatchAttachment('ctx_remote')?.effects ?? '[]'
    ) as DispatchInputEffectRow[]
    expect(stored.find((effect) => effect.kind === 'dispatch_input')).toMatchObject({
      state: 'failed',
      cause: 'agent_prompt_blocked',
      detail: 'agent_prompt_blocked'
    })
  })
})

// Why: on a federated start the submission happens on the remote host, so the
// exception never reaches the Run home at all. The remote receipt is the only
// carrier, and a coordinator that can no longer reach that server has nothing
// left to read unless the home Dispatch keeps what it was handed.
describe('federated Run home dispatch input verdict', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  afterEach(() => {
    h.cleanup()
  })

  const REMOTE_FAILURE_EFFECTS = [
    { kind: 'worktree', action: 'created', id: 'repo::remote-worktree' },
    { kind: 'terminal', role: 'agent', action: 'created', id: 'term_remote_worker' },
    {
      kind: 'dispatch_input',
      role: 'agent',
      id: 'term_remote_worker',
      state: 'failed',
      cause: 'agent_prompt_stalled',
      detail: 'agent_prompt_stalled'
    }
  ]

  async function startRemoteWorker(remoteState: 'failed' | 'outcome_unknown') {
    ;({ db, runtime } = h.setup())
    const task = db.createTask({ spec: 'remote worker whose preamble never submits' })
    // Why: the remote echoes back the Dispatch id the home just created, and the
    // home rejects a mismatch, so the mock has to read the row it just wrote.
    const homeDispatchId = (): string => db.getDispatchContext(task.id)!.id
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_windows',
      name: 'windows',
      peerFingerprint: 'windows_peer'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_environment, method) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
            ]
          } as never
        }
        if (method !== 'orchestration.federationAttachStart') {
          throw new Error(`Unexpected remote method ${method}`)
        }
        return {
          dispatchId: homeDispatchId(),
          state: remoteState,
          runtimeEpoch: 'windows_epoch',
          failedStage: 'dispatch_input',
          lastError: 'agent_prompt_stalled',
          effects: REMOTE_FAILURE_EFFECTS,
          residualResources: [
            { kind: 'terminal', role: 'agent', action: 'created', id: 'term_remote_worker' }
          ]
        } as never
      }
    )
    const method = h.findMethod('orchestration.workerStart')
    return (await method.handler(
      method.params!.parse({
        task: task.id,
        from: 'term_coord',
        on: 'windows',
        worktree: 'id:repo::remote-worktree',
        agent: 'codex'
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'coordinator',
          requestId: 'request_remote_start',
          method: 'orchestration.workerStart',
          payloadHash: 'remote_payload'
        }
      }
    )) as { dispatchId: string; state: string; effects: DispatchInputEffectRow[] }
  }

  function readPersistedDispatchInput(dispatchId: string): DispatchInputEffectRow | undefined {
    const stored = JSON.parse(
      db.getWorkerDispatch(dispatchId)?.effects ?? '[]'
    ) as DispatchInputEffectRow[]
    return stored.find((effect) => effect.kind === 'dispatch_input')
  }

  it('persists the remote failure evidence on the home Dispatch', async () => {
    const result = await startRemoteWorker('failed')

    expect(result.state).toBe('failed')
    expect(readPersistedDispatchInput(result.dispatchId)).toMatchObject({
      state: 'failed',
      cause: 'agent_prompt_stalled',
      detail: 'agent_prompt_stalled',
      id: 'term_remote_worker'
    })
  })

  it('keeps the remote evidence when the remote outcome is unknown', async () => {
    const result = await startRemoteWorker('outcome_unknown')

    expect(result.state).toBe('outcome_unknown')
    expect(readPersistedDispatchInput(result.dispatchId)).toMatchObject({
      state: 'failed',
      cause: 'agent_prompt_stalled'
    })
    // Why: the unknown receipt used to hard-code effects: [], so the coordinator
    // was told nothing even when the remote had just described the failure.
    expect(result.effects).toEqual(REMOTE_FAILURE_EFFECTS)
  })
})

describe('dispatch input failure causes', () => {
  it('names the not-ready renderer graph rather than collapsing it to unknown', () => {
    expect(
      dispatchInputFailedEffect('term_worker', new Error('runtime_unavailable'))
    ).toMatchObject({ cause: 'runtime_unavailable', detail: 'runtime_unavailable' })
  })

  it('maps the 16 MiB input guard, which throws prose instead of a code', () => {
    expect(
      dispatchInputFailedEffect('term_worker', new Error(TERMINAL_INPUT_TOO_LARGE_ERROR))
    ).toMatchObject({
      cause: 'terminal_input_too_large',
      detail: TERMINAL_INPUT_TOO_LARGE_ERROR
    })
  })
})
