import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
} from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { RemoteRuntimeClientError } from '../../../../../shared/remote-runtime/remote-runtime-client-error'
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

const sendingConnection = {
  endpoint: 'ws://127.0.0.1:1',
  hostPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  credential: { kind: 'token' as const, deviceToken: 'test-home-token' }
}

type Sent = {
  method: string
  params: Record<string, unknown>
  envelope?: RuntimeOrchestrationEnvelope
}
type Answer = { result: unknown } | { error: string; data?: unknown } | 'unreachable'

const unreachable = (pairingStage: 'connect' | 'runtime') =>
  new RemoteRuntimeClientError(
    'remote_runtime_unavailable',
    'Could not connect to the remote Orca runtime.',
    { pairingStage }
  )

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
  let statusAnswers: ('unreachable' | undefined)[]
  let dialFailure: Error | undefined
  let whileSending: () => Promise<void>
  let pulls: unknown[][]
  let sequence = 0
  const DEV_B: OrchestrationWorkerServer = {
    environmentId: 'env_b',
    name: 'devB',
    peerFingerprint: 'Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU',
    homePeerFingerprint: 'd9b49845ccf7825b16d8a6026f24f283a700ec94ad6e750e0ff344db365934a0',
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
        return statusAnswers.shift() === 'unreachable'
          ? {
              id: method,
              ok: false,
              error: { code: 'remote_runtime_unavailable', message: 'unreachable' }
            }
          : ok({ runtimeId: 'runtime_b', capabilities })
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
      const guard = await send?.prepareGuard?.(sendingConnection)
      guard?.()
      if (dialFailure) {
        throw dialFailure
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
        throw unreachable('runtime')
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
    server = { ...DEV_B }
    sent = []
    answers = {}
    statusAnswers = []
    dialFailure = undefined
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

  it("sends a new-child there with this caller's workspace as its parent", async () => {
    const parent = {
      installationId: 'install_a',
      workspaceKey: 'worktree:repo_a::/a/home',
      instanceId: 'instance_a'
    } as const
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start reads only the caller terminal's workspace.
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'repo_a::/a/home' } as never)
    const resolveParent = vi
      .spyOn(runtime, 'resolveCallerParentForAnotherStore')
      .mockResolvedValue({ parent, source: 'env-workspace' })
    answers['orchestration.workerStart'] = [started()]

    const response = await call('orchestration.workerStart', {
      from: 'term_coord',
      on: 'devB',
      spec: 'build it',
      worktree: 'new-child',
      repo: 'id:repo_b'
    })

    expect(response.ok).toBe(true)
    expect(resolveParent.mock.calls[0]?.[0]).toEqual({ envParentWorkspace: 'id:repo_a::/a/home' })
    expect(sent.find((s) => s.method === 'orchestration.workerStart')?.params).toMatchObject({
      worktree: 'new-child',
      repo: 'id:repo_b',
      crossStoreParent: parent
    })
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

  const startNeverSent = () =>
    call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'never sent', worktree: 'new-top-level' },
      { requestId: REQUEST }
    )
  const onlyTaskId = () => String(record(db.db.prepare('SELECT id FROM tasks').get()).id)
  const cancel = (id: string) =>
    call('orchestration.taskUpdate', { id, status: 'failed', callerTerminalHandle: 'term_coord' })

  it.each([
    ['the dial failed', () => (dialFailure = unreachable('connect'))],
    [
      'the server refused its access grant',
      () =>
        (dialFailure = new RemoteRuntimeClientError('unauthorized', 'Pairing was revoked.', {
          pairingStage: 'access-grant'
        }))
    ],
    // The capability probe answers; the contract check the start waits on does not.
    ['its contract check went unanswered', () => (statusAnswers = [undefined, 'unreachable'])]
  ])(
    'keeps a start that never left this Orca reserved, marked as never sent, because %s',
    async (_why, failSend) => {
      failSend()
      const response = await startNeverSent()

      expect(response.ok).toBe(false)
      expect(sent.map((s) => s.method)).not.toContain('orchestration.workerStart')
      const taskId = onlyTaskId()
      expect(getRemotePlacement(db, taskId)).toMatchObject({ state: 'reserved' })
      expect(getRemotePlacement(db, taskId)?.never_sent_at).not.toBeNull()
      expect(db.getTask(taskId)?.status).toBe('dispatched')

      dialFailure = undefined
      answers['orchestration.workerStart'] = [started()]
      const retried = await startNeverSent()

      expect(record(retried.ok ? retried.result : undefined)).toMatchObject({
        taskId,
        dispatchId: 'ctx_b1'
      })
      expect(getRemotePlacement(db, taskId)).toMatchObject({
        state: 'accepted',
        dispatch_id: 'ctx_b1',
        never_sent_at: null
      })
    }
  )

  it('lets task-update fail a Task whose every start failed before leaving this Orca', async () => {
    dialFailure = unreachable('connect')
    await startNeverSent()
    await startNeverSent()
    const taskId = onlyTaskId()

    const response = await cancel(taskId)

    expect(response.ok).toBe(true)
    expect(getRemotePlacement(db, taskId)).toBeUndefined()
    expect(db.getTask(taskId)?.status).toBe('failed')
  })

  it('still refuses task-update for a start whose answer was lost after sending', async () => {
    const lost = await startNeverSent()
    expect(lost.ok ? undefined : lost.error.code).toBe('remote_runtime_unavailable')
    const taskId = onlyTaskId()
    expect(getRemotePlacement(db, taskId)).toMatchObject({ state: 'reserved', never_sent_at: null })

    const response = await cancel(taskId)

    expect(response.ok ? undefined : response.error.code).toBe('task_not_startable')
    expect(getRemotePlacement(db, taskId)).toMatchObject({ state: 'reserved' })
    expect(db.getTask(taskId)?.status).toBe('dispatched')
  })

  it('clears the never-sent mark before a retry sends, so a loss after that send stays fenced', async () => {
    dialFailure = unreachable('connect')
    await startNeverSent()
    const taskId = onlyTaskId()
    dialFailure = undefined
    let markWhileSending: string | null | undefined
    whileSending = async () => {
      markWhileSending = getRemotePlacement(db, taskId)?.never_sent_at
    }

    const retried = await startNeverSent()

    expect(retried.ok ? undefined : retried.error.code).toBe('remote_runtime_unavailable')
    expect(markWhileSending).toBeNull()
    expect(getRemotePlacement(db, taskId)).toMatchObject({ state: 'reserved', never_sent_at: null })
    expect((await cancel(taskId)).ok).toBe(false)
  })

  it('keeps the reservation unmarked when a retry fails before sending, since the first send may have landed', async () => {
    const lost = await startNeverSent()
    expect(lost.ok ? undefined : lost.error.code).toBe('remote_runtime_unavailable')
    const taskId = onlyTaskId()

    dialFailure = unreachable('connect')
    const retried = await startNeverSent()

    expect(retried.ok ? undefined : retried.error.code).toBe('remote_runtime_unavailable')
    expect(getRemotePlacement(db, taskId)).toMatchObject({ state: 'reserved', never_sent_at: null })
    expect(db.getTask(taskId)?.status).toBe('dispatched')
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

  it("records the agent the server's start receipt names in its launch", async () => {
    answers['orchestration.workerStart'] = [
      {
        result: {
          dispatchId: 'ctx_b1',
          run: { id: 'run_on_b' },
          state: 'ready',
          launch: { requested: { agent: null }, effective: { agent: 'codex' } }
        }
      }
    ]
    const response = await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'build it', worktree: 'new-top-level' },
      { requestId: REQUEST }
    )

    expect(response.ok).toBe(true)
    expect(getRemoteDispatch(db, 'ctx_b1')).toMatchObject({ agent: 'codex' })
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
