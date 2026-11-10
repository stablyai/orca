import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
} from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../../rpc/dispatcher'
import type { RpcResponse } from '../../../rpc/core'
import { ORCHESTRATION_METHODS } from '../../../rpc/methods/orchestration/orchestration'
import { OrchestrationDb } from '../../db/orchestration-db'
import { getRemoteDispatch } from '../../db/remote-owned/remote-dispatch-records'
import { importRemoteOwnedItem } from '../../db/remote-owned/remote-owned-import'
import { getRemotePlacement } from '../../db/remote-owned/remote-placements'
import { remoteServerPin } from '../../db/remote-owned/remote-run-links'
import type {
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from '../environment-transport'

const COORDINATOR_PANE = 'tab_coord:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab_other:22222222-2222-4222-8222-222222222222'
const REQUEST = '6f1c2f1e-3a7b-4d55-9c1e-0a1b2c3d4e5f'

type Sent = {
  method: string
  params: Record<string, unknown>
  envelope?: RuntimeOrchestrationEnvelope
}
type Answer = { result: unknown } | { error: string; data?: unknown } | 'unreachable'

describe('commands about a worker a paired server owns', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let dispatcher: RpcDispatcher
  let sent: Sent[]
  let answers: Record<string, Answer[]>
  let capabilities: string[]
  let whileSending: () => Promise<void>
  let sequence = 0
  const server: OrchestrationWorkerServer = {
    environmentId: 'env_b',
    name: 'devB',
    peerFingerprint: 'host_b',
    homePeerFingerprint: 'cred_a',
    pairingRevision: 1
  }

  const transport = (): OrchestrationEnvironmentTransport => ({
    resolve: () => server,
    hasEnvironment: () => true,
    call: async (_selector, method, params, _timeout, envelope, _revision, send) => {
      const ok = (result: unknown): RuntimeRpcResponse<unknown> => ({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'runtime_b' }
      })
      if (method === 'status.get') {
        return ok({ runtimeId: 'runtime_b', capabilities })
      }
      if (method === 'orchestration.peerMailPull') {
        return ok({ items: [] })
      }
      const prepared = send?.prepareRequest?.({ params, envelope, measure: () => 0 })
      sent.push({
        method,
        params: (prepared?.params ?? params) as Record<string, unknown>,
        envelope: prepared?.envelope ?? envelope
      })
      await whileSending()
      const answer = answers[method]?.shift() ?? 'unreachable'
      if (answer === 'unreachable') {
        throw Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
          code: 'remote_runtime_unavailable'
        })
      }
      return 'result' in answer
        ? ok(answer.result)
        : {
            id: method,
            ok: false,
            error: { code: answer.error, message: answer.error, data: answer.data }
          }
    }
  })

  beforeEach(() => {
    sent = []
    answers = {}
    whileSending = async () => undefined
    capabilities = [
      ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
      ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
    ]
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport()
    })
    vi.spyOn(runtime, 'readMachineName').mockReturnValue('Mac A')
    const panes: Record<string, string> = { term_coord: COORDINATOR_PANE, term_other: OTHER_PANE }
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => panes[handle] ?? null)
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation(
      (handle) => panes[handle] ?? null
    )
    runtime.setOrchestrationDb(db)
    dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  })

  afterEach(() => {
    runtime.stopOrchestrationFederationRelay()
    db.close()
    vi.restoreAllMocks()
  })

  function call(
    method: string,
    params: Record<string, unknown>,
    { pane = COORDINATOR_PANE, requestId }: { pane?: string; requestId?: string } = {}
  ): Promise<RpcResponse> {
    sequence += 1
    return dispatcher.dispatch({
      id: `call_${sequence}`,
      authToken: 'token',
      method,
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationCompatibilityEvidence: { paneKey: pane },
      ...(requestId ? { orchestrationRequestId: requestId } : {})
    })
  }

  const started = (dispatchId = 'ctx_b1'): Answer => ({
    result: { dispatchId, runId: 'run_on_b', run: { id: 'run_on_b' }, state: 'ready' }
  })

  async function startOnB(requestId = REQUEST) {
    answers['orchestration.workerStart'] = [started()]
    const response = await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'build it', worktree: 'new-top-level' },
      { requestId }
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result as { taskId: string; runId: string; dispatchId: string }
  }

  it("starts the worker on a server that owns its workers, then records it under this Orca's Task", async () => {
    const receipt = await startOnB()

    const start = sent.find((s) => s.method === 'orchestration.workerStart')!
    expect(start.params).toMatchObject({ spec: 'build it', adoptTaskId: receipt.taskId })
    expect(start.params).not.toHaveProperty('from')
    expect(start.envelope?.orchestrationPeerRun?.label).toBe('Mac A')
    expect(receipt.runId).not.toBe('run_on_b')
    expect(db.getTask(receipt.taskId)).toMatchObject({
      run_id: receipt.runId,
      status: 'dispatched'
    })
    expect(getRemoteDispatch(db, 'ctx_b1')).toMatchObject({ task_id: receipt.taskId })
  })

  it("keeps today's remote attachment for a server without the capability", async () => {
    capabilities = [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY]
    await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'build it', worktree: 'new-top-level' },
      { requestId: REQUEST }
    )

    expect(sent.some((s) => s.method === 'orchestration.workerStart')).toBe(false)
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM remote_placements').get()).toEqual({ n: 0 })
  })

  it('frees the Task when the server refuses the start, and keeps it fenced when the answer is lost', async () => {
    answers['orchestration.workerStart'] = [
      { error: 'invalid_argument', data: { effectsApplied: false } }
    ]
    await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'refused', worktree: 'current' },
      { requestId: REQUEST }
    )
    const refusedTask = String((sent[0].params as { adoptTaskId: string }).adoptTaskId)
    expect(getRemotePlacement(db, refusedTask)).toBeUndefined()
    // As a refused local start creates no Task, a refused start there leaves none here.
    expect(db.getTask(refusedTask)).toBeUndefined()

    const lost = await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'lost', worktree: 'new-top-level' },
      { requestId: 'a3f1e9d2-5b6c-4d7e-8f90-1a2b3c4d5e6f' }
    )
    expect(lost.ok ? undefined : lost.error.code).toBe('remote_runtime_unavailable')
    const lostTask = String((sent[1].params as { adoptTaskId: string }).adoptTaskId)
    expect(getRemotePlacement(db, lostTask)).toMatchObject({
      state: 'reserved',
      outcome_unknown: 1
    })
  })

  it('records nothing for a start the server answers after the Run was reset, and says so', async () => {
    whileSending = async () => {
      db.resetTasks()
    }
    answers['orchestration.workerStart'] = [started()]
    const response = await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'late', worktree: 'new-top-level' },
      { requestId: REQUEST }
    )

    expect(response.ok ? undefined : response.error.code).toBe('run_not_found')
    expect(getRemoteDispatch(db, 'ctx_b1')).toBeUndefined()
  })

  it('keeps the start fenced for the orphan lookup when the server says its outcome is unknown', async () => {
    answers['orchestration.workerStart'] = [{ error: 'operation_unknown' }]
    await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'unknown', worktree: 'new-top-level' },
      { requestId: REQUEST }
    )

    const task = String(sent[0].params.adoptTaskId)
    expect(getRemotePlacement(db, task)).toMatchObject({ state: 'reserved', outcome_unknown: 1 })
  })

  it('never sends a start that names a remote Dispatch to retry without --on', async () => {
    const receipt = await startOnB()
    const retry = await call('orchestration.workerStart', {
      from: 'term_coord',
      task: receipt.taskId,
      retryOf: 'ctx_b1',
      agent: 'claude'
    })

    expect(retry.ok).toBe(false)
    expect(sent.filter((s) => s.method === 'orchestration.workerStart')).toHaveLength(1)
  })

  it('scopes the retry key to the caller: two terminals reusing an ID never collide, one retrying gets its own key', async () => {
    const receipt = await startOnB()
    answers['orchestration.workerRelease'] = [
      { result: { state: 'released' } },
      { result: { state: 'released' } },
      { result: { state: 'released' } }
    ]
    const release = (pane: string) =>
      call('orchestration.workerRelease', { dispatch: 'ctx_b1' }, { pane, requestId: REQUEST })
    await release(COORDINATOR_PANE)
    await release(COORDINATOR_PANE)
    await release(OTHER_PANE)

    const keys = sent
      .filter((s) => s.method === 'orchestration.workerRelease')
      .map((s) => s.envelope?.orchestrationRequestId)
    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).not.toBe(keys[0])
    expect(keys[0]).not.toBe(REQUEST)
    expect(receipt.dispatchId).toBe('ctx_b1')
  })

  it("answers in the caller's terms: its own request ID and its own Run, never the server's", async () => {
    const receipt = await startOnB()
    const key = () =>
      sent.findLast((s) => s.method === 'orchestration.workerRelease')?.envelope
        ?.orchestrationRequestId
    answers['orchestration.workerRelease'] = [{ result: { state: 'released' } }]
    await call('orchestration.workerRelease', { dispatch: 'ctx_b1' }, { requestId: REQUEST })
    answers['orchestration.workerRelease'] = [
      {
        error: 'operation_unknown',
        data: { requestId: key(), runId: 'run_on_b' }
      }
    ]
    const unknown = await call(
      'orchestration.workerRelease',
      { dispatch: 'ctx_b1' },
      { requestId: REQUEST }
    )

    expect(unknown.ok ? undefined : unknown.error.data).toMatchObject({
      requestId: REQUEST,
      runId: receipt.runId,
      server: 'devB'
    })
  })

  it("answers a remote worker's question only from its Run's coordinator, as a local one is", async () => {
    const receipt = await startOnB()
    const link = db.db.prepare('SELECT * FROM remote_run_links').get() as {
      conversation_id: string
    }
    importRemoteOwnedItem(db, remoteServerPin(server), {
      conversationId: link.conversation_id,
      sequence: 1,
      messageId: 'msg_q1',
      kind: 'worker_mail',
      payload: JSON.stringify({
        v: 1,
        id: 'msg_q1',
        homeRunId: receipt.runId,
        peerRunId: 'run_on_b',
        message: {
          from: 'term_w',
          type: 'question',
          subject: 'Which color?',
          body: 'Which color?',
          payload: null,
          priority: 'normal',
          threadId: null
        },
        dispatchId: 'ctx_b1',
        taskId: receipt.taskId
      })
    })
    answers['orchestration.reply'] = [{ result: { messageId: 'msg_a1' } }]

    const stranger = await call(
      'orchestration.reply',
      { id: 'msg_q1', body: 'red', from: 'term_other' },
      { pane: OTHER_PANE }
    )
    const coordinator = await call('orchestration.reply', {
      id: 'msg_q1',
      body: 'teal',
      from: 'term_coord'
    })

    expect(stranger.ok).toBe(false)
    expect(coordinator.ok).toBe(true)
    expect(
      sent.filter((s) => s.method === 'orchestration.reply').map((s) => s.params.body)
    ).toEqual(['teal'])
  })

  it('owes a stop the server did not answer and says so', async () => {
    await startOnB()
    const stop = await call('orchestration.workerStop', { dispatch: 'ctx_b1' })

    expect(stop.ok ? stop.result : undefined).toMatchObject({ state: 'stop_requested' })
    expect(getRemoteDispatch(db, 'ctx_b1')).toMatchObject({ stop_owed: 1 })
  })
})
