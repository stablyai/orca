import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorkerStartCardModule from '../../workers/launch/worker-start-card'
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

const recordStart = vi.hoisted(() => vi.fn())
vi.mock('../../workers/launch/worker-start-card', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkerStartCardModule>()),
  prepareWorkerStartCard: () => recordStart
}))

const COORDINATOR_PANE = 'tab_coord:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab_other:22222222-2222-4222-8222-222222222222'
const REQUEST = '6f1c2f1e-3a7b-4d55-9c1e-0a1b2c3d4e5f'

type Sent = {
  method: string
  params: Record<string, unknown>
  envelope?: RuntimeOrchestrationEnvelope
}
type Answer = { result: unknown } | { error: string; data?: unknown } | 'unreachable'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...value } : {}
}

describe('commands about a worker a paired server owns', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let dispatcher: RpcDispatcher
  let sent: Sent[]
  let answers: Record<string, Answer[]>
  let capabilities: string[]
  let whileSending: () => Promise<void>
  let pulls: unknown[][]
  let sequence = 0
  const DEV_B: OrchestrationWorkerServer = {
    environmentId: 'env_b',
    name: 'devB',
    peerFingerprint: 'host_b',
    homePeerFingerprint: 'cred_a',
    pairingRevision: 1
  }
  let server = DEV_B

  const transport = (): OrchestrationEnvironmentTransport => ({
    resolve: () => server,
    hasEnvironment: () => true,
    call: async (_selector, method, params, _timeoutMs, envelope, _revision, send) => {
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
        const items = pulls.shift()
        if (!items) {
          // A real pull waits there for mail; yielding keeps the loop from starving timers.
          await new Promise((resolve) => setImmediate(resolve))
        }
        return ok({ items: items ?? [] })
      }
      if (method === 'orchestration.peerMailAck') {
        return ok({})
      }
      const prepared = send?.prepareRequest?.({ params, envelope, measure: () => 0 })
      sent.push({
        method,
        params: record(prepared?.params ?? params),
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
    recordStart.mockClear()
    server = { ...DEV_B }
    sent = []
    answers = {}
    whileSending = async () => undefined
    pulls = []
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
    vi.useRealTimers()
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
    const receipt = record(response.result)
    return {
      taskId: String(receipt.taskId),
      runId: String(receipt.runId),
      dispatchId: String(receipt.dispatchId)
    }
  }

  it("shows the started worker's agent in the caller's chat only once the server readied it", async () => {
    answers['orchestration.workerStart'] = [
      { result: { dispatchId: 'ctx_b1', run: { id: 'run_on_b' }, agent: 'codex', state: 'ready' } },
      { result: { dispatchId: 'ctx_b2', run: { id: 'run_on_b' }, agent: 'codex', state: 'failed' } }
    ]
    for (const [spec, requestId] of [
      ['ready', REQUEST],
      ['failed', 'a3f1e9d2-5b6c-4d7e-8f90-1a2b3c4d5e6f']
    ]) {
      await call(
        'orchestration.workerStart',
        { from: 'term_coord', on: 'devB', spec, worktree: 'new-top-level' },
        { requestId }
      )
    }

    expect(recordStart.mock.calls).toEqual([
      [
        {
          dispatchId: 'ctx_b1',
          workerAddress: 'dispatch:ctx_b1',
          task: 'ready',
          agent: 'codex'
        }
      ]
    ])
  })

  it('fails the Task when the server refuses the start, and keeps it fenced when the answer is lost', async () => {
    answers['orchestration.workerStart'] = [
      { error: 'invalid_argument', data: { effectsApplied: false } }
    ]
    let dependent: string | undefined
    whileSending = async () => {
      // Another caller lists the reserved Task and depends on it while its start waits.
      const reserved = db.getTask(String(sent[0].params.adoptTaskId))!
      dependent = db.createTask({
        spec: 'after it',
        deps: [reserved.id],
        runId: reserved.run_id
      }).id
    }
    await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'refused', worktree: 'current' },
      { requestId: REQUEST }
    )
    whileSending = async () => undefined
    const refusedTask = String(sent[0].params.adoptTaskId)
    expect(getRemotePlacement(db, refusedTask)).toBeUndefined()
    // As a local start that fails after creating its Task leaves it failed, so its dependent keeps it.
    expect(db.getTask(refusedTask)?.status).toBe('failed')
    expect(db.getTask(dependent!)?.deps).toContain(refusedTask)

    const lost = await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'lost', worktree: 'new-top-level' },
      { requestId: 'a3f1e9d2-5b6c-4d7e-8f90-1a2b3c4d5e6f' }
    )
    expect(lost.ok ? undefined : lost.error.code).toBe('remote_runtime_unavailable')
    const lostTask = String(sent[1].params.adoptTaskId)
    expect(getRemotePlacement(db, lostTask)).toMatchObject({ state: 'reserved' })
  })

  it("adopts a start whose answer was lost from the server's queue item alone", async () => {
    const lost = await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'lost', worktree: 'new-top-level' },
      { requestId: REQUEST }
    )
    expect(lost.ok ? undefined : lost.error.code).toBe('remote_runtime_unavailable')
    const start = sent.find((s) => s.method === 'orchestration.workerStart')!
    const taskId = String(start.params.adoptTaskId)
    const link = record(db.db.prepare('SELECT * FROM remote_run_links').get())
    // The server's insert trigger queued the Dispatch it created; nothing answers a lookup.
    pulls.push([
      {
        conversationId: link.conversation_id,
        sequence: 1,
        messageId: 'state_1',
        kind: 'worker_state',
        payload: JSON.stringify({
          v: 1,
          id: 'state_1',
          homeRunId: link.run_id,
          peerRunId: 'run_on_b',
          dispatch: {
            id: 'ctx_lost',
            taskId,
            status: 'pending',
            workerState: 'starting',
            lastFailure: null,
            agent: 'claude'
          },
          task: { status: 'dispatched', result: null },
          correctedUnobservedPrompt: false,
          removed: null
        })
      }
    ])
    runtime.ensureOrchestrationFederationRelay(String(link.run_id))

    await vi.waitFor(() =>
      expect(getRemotePlacement(db, taskId)).toMatchObject({
        state: 'accepted',
        dispatch_id: 'ctx_lost'
      })
    )
    expect(sent.map((s) => s.method)).not.toContain('orchestration.dispatchShow')
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

  it("answers a remote worker's question only from its Run's coordinator, as a local one is", async () => {
    const receipt = await startOnB()
    const link = record(db.db.prepare('SELECT conversation_id FROM remote_run_links').get())
    importRemoteOwnedItem(db, remoteServerPin(server), {
      conversationId: String(link.conversation_id),
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

  /** devB's queue item saying where its Dispatch and Task now stand. */
  function importState(
    runId: string,
    taskId: string,
    sequence: number,
    state: {
      status: string
      workerState: string
      taskStatus: string
      result?: string
      removed?: string
    }
  ) {
    const link = record(db.db.prepare('SELECT conversation_id FROM remote_run_links').get())
    importRemoteOwnedItem(db, remoteServerPin(server), {
      conversationId: String(link.conversation_id),
      sequence,
      messageId: `state_${sequence}`,
      kind: 'worker_state',
      payload: JSON.stringify({
        v: 1,
        id: `state_${sequence}`,
        homeRunId: runId,
        peerRunId: 'run_on_b',
        dispatch: {
          id: 'ctx_b1',
          taskId,
          status: state.status,
          workerState: state.workerState,
          lastFailure: null,
          agent: 'claude'
        },
        task: { status: state.taskStatus, result: state.result ?? null },
        correctedUnobservedPrompt: false,
        removed: state.removed ? { reason: state.removed } : null
      })
    })
  }

  for (const method of ['orchestration.workerStop', 'orchestration.workerAbandon']) {
    it(`settles the Task here at once when the server does not answer ${method}, and the first result stands`, async () => {
      const { taskId, runId } = await startOnB()
      importState(runId, taskId, 1, {
        status: 'dispatched',
        workerState: 'ready',
        taskStatus: 'dispatched'
      })

      const stopped = await call(method, { dispatch: 'ctx_b1' })
      // A stop stays owed; an abandon, as a local one, stops nothing.
      const stop = method === 'orchestration.workerStop'
      expect(stopped.ok ? stopped.result : undefined).toMatchObject({
        state: stop ? 'stop_requested' : 'abandoned'
      })
      expect(getRemoteDispatch(db, 'ctx_b1')).toMatchObject({ stop_owed: stop ? 1 : 0 })
      // As a local stop leaves it: blocked, so it can be retried.
      expect(db.getTask(taskId)?.status).toBe('blocked')

      // devB finished before it got the stop; its late result changes only its record here.
      importState(runId, taskId, 2, {
        status: 'completed',
        workerState: 'succeeded',
        taskStatus: 'completed',
        result: 'done'
      })
      expect(db.getTask(taskId)?.status).toBe('blocked')
      expect(getRemoteDispatch(db, 'ctx_b1')).toMatchObject({
        status: 'completed',
        worker_state: 'succeeded',
        task_settled_here: stop ? 1 : 2
      })

      answers['orchestration.workerStart'] = [started('ctx_b2')]
      const retry = await call('orchestration.workerStart', {
        from: 'term_coord',
        on: 'devB',
        task: taskId,
        retryOf: 'ctx_b1',
        worktree: 'new-top-level'
      })
      expect(retry.ok).toBe(true)
    })
  }
})
