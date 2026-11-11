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
import { WorkerStartParams } from '../../../../../shared/rpc-contract/orchestration-worker-start-params'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../../rpc/dispatcher'
import type { RpcResponse } from '../../../rpc/core'
import { ORCHESTRATION_METHODS } from '../../../rpc/methods/orchestration/orchestration'
import { OrchestrationDb } from '../../db/orchestration-db'
import { getRemoteDispatch } from '../../db/remote-owned/remote-dispatch-records'
import { importRemoteOwnedItem } from '../../db/remote-owned/remote-owned-import'
import { getRemotePlacement } from '../../db/remote-owned/remote-placements'
import { closeRemoteRunLink, remoteServerPin } from '../../db/remote-owned/remote-run-links'
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
  let sleeping: boolean
  let pulls: unknown[][]
  let paired: boolean
  let pullFailures: number
  let sequence = 0
  let server: OrchestrationWorkerServer = {
    environmentId: 'env_b',
    name: 'devB',
    peerFingerprint: 'host_b',
    homePeerFingerprint: 'cred_a',
    pairingRevision: 1
  }

  const transport = (): OrchestrationEnvironmentTransport => ({
    resolve: () => server,
    hasEnvironment: () => paired,
    call: async (_selector, method, params, timeoutMs, envelope, _revision, send) => {
      const ok = (result: unknown): RuntimeRpcResponse<unknown> => ({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'runtime_b' }
      })
      if (!paired) {
        throw new Error('Unknown environment: env_b')
      }
      if (sleeping) {
        // A sleeping laptop keeps its socket open, so only each call's own timeout ends the wait.
        return new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                Object.assign(new Error('The remote Orca runtime timed out.'), {
                  code: 'runtime_timeout'
                })
              ),
            timeoutMs
          )
        )
      }
      if (method === 'status.get') {
        return ok({ runtimeId: 'runtime_b', capabilities })
      }
      if (method === 'orchestration.peerMailPull') {
        if (pullFailures > 0) {
          pullFailures -= 1
          throw Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
            code: 'remote_runtime_unavailable'
          })
        }
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
    server = { ...server, pairingRevision: 1 }
    sent = []
    answers = {}
    whileSending = async () => undefined
    sleeping = false
    pulls = []
    paired = true
    pullFailures = 0
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

  it('keeps a lost start reserved for the queue, and never asks the server about it', async () => {
    const now = Date.parse('2026-11-10T12:00:00Z')
    vi.useFakeTimers({ toFake: ['Date'], now })
    await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'lost', worktree: 'new-top-level' },
      { requestId: REQUEST }
    )
    const taskId = String(
      sent.find((s) => s.method === 'orchestration.workerStart')?.params.adoptTaskId
    )
    // Well past any interval a lookup would wait, with the pull loop still going round.
    vi.setSystemTime(now + 120_000)
    await vi.waitFor(() =>
      expect(runtime.getPeerServerAnswerStatus('env_b')?.answeredAt).toBeGreaterThan(now + 60_000)
    )

    expect(sent.map((s) => s.method)).not.toContain('orchestration.dispatchShow')
    expect(getRemotePlacement(db, taskId)).toMatchObject({ state: 'reserved' })
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

  it('keeps the start fenced when the server says its outcome is unknown', async () => {
    answers['orchestration.workerStart'] = [{ error: 'operation_unknown' }]
    await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'unknown', worktree: 'new-top-level' },
      { requestId: REQUEST }
    )

    const task = String(sent[0].params.adoptTaskId)
    expect(getRemotePlacement(db, task)).toMatchObject({ state: 'reserved' })
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

  it("retries a failed remote worker with --on as the server's ordinary retry of its Task", async () => {
    const receipt = await startOnB()
    const link = record(db.db.prepare('SELECT conversation_id FROM remote_run_links').get())
    importRemoteOwnedItem(db, remoteServerPin(server), {
      conversationId: String(link.conversation_id),
      sequence: 1,
      messageId: 'state_1',
      kind: 'worker_state',
      payload: JSON.stringify({
        v: 1,
        id: 'state_1',
        homeRunId: receipt.runId,
        peerRunId: 'run_on_b',
        dispatch: {
          id: 'ctx_b1',
          taskId: receipt.taskId,
          status: 'failed',
          workerState: 'failed',
          lastFailure: null,
          agent: 'claude'
        },
        task: { status: 'failed', result: null },
        correctedUnobservedPrompt: false,
        removed: null
      })
    })
    answers['orchestration.workerStart'] = [started('ctx_b2')]

    const retry = await call('orchestration.workerStart', {
      from: 'term_coord',
      on: 'devB',
      task: receipt.taskId,
      retryOf: 'ctx_b1',
      worktree: 'new-top-level'
    })

    expect(retry.ok ? null : retry.error).toBeNull()
    const forwarded = sent.findLast((s) => s.method === 'orchestration.workerStart')!
    // The server binds --from to the pairing's address at admission.
    const onServer = WorkerStartParams.safeParse({ ...forwarded.params, from: 'peer' })
    expect(onServer.error?.issues).toBeUndefined()
    expect(forwarded.params).toMatchObject({ task: receipt.taskId, retryOf: 'ctx_b1' })
  })

  it('fails the Task when the pairing is re-made while its start waits', async () => {
    whileSending = async () => {
      server.pairingRevision = 2
      closeRemoteRunLink(
        db,
        String(
          record(db.db.prepare('SELECT conversation_id FROM remote_run_links').get())
            .conversation_id
        ),
        're-paired'
      )
    }
    answers['orchestration.workerStart'] = [started()]
    const response = await call(
      'orchestration.workerStart',
      { from: 'term_coord', on: 'devB', spec: 'repaired', worktree: 'new-top-level' },
      { requestId: REQUEST }
    )

    expect(response.ok).toBe(false)
    const taskId = String(sent[0].params.adoptTaskId)
    expect(db.getTask(taskId)?.status).toBe('failed')
    // Kept, so a later start of this Task there is refused here rather than by the server.
    expect(getRemotePlacement(db, taskId)).toMatchObject({ task_id: taskId })
  })

  it("shows this Orca's record of a worker whose pairing was re-made", async () => {
    await startOnB()
    closeRemoteRunLink(
      db,
      String(
        record(db.db.prepare('SELECT conversation_id FROM remote_run_links').get()).conversation_id
      ),
      're-paired'
    )
    const show = await call('orchestration.workerShow', { dispatch: 'ctx_b1' })

    expect(show.ok ? record(show.result).server : undefined).toMatchObject({ name: 'devB' })
  })

  it("shows a remote worker from this Orca's record without calling its server", async () => {
    const { runId } = await startOnB()
    // devB is live and would say something newer; show still reads the record list reads.
    answers['orchestration.workerShow'] = [
      { result: { worker: { dispatchId: 'ctx_b1', state: 'running', stage: 'working' } } }
    ]
    await vi.waitFor(() => expect(runtime.getPeerServerAnswerStatus('env_b')).toBeDefined())
    const calls = sent.length
    const show = await call('orchestration.workerShow', { dispatch: 'ctx_b1' })
    const list = await call('orchestration.workerList', { run: runId, paginate: true })

    expect(sent.slice(calls).map((s) => s.method)).not.toContain('orchestration.workerShow')
    // What the pull loop last heard from devB, which answers its pulls.
    expect(record(record(show.ok ? show.result : undefined).server).reachable).toBe(true)
    const shown = record(show.ok ? show.result : undefined)
    const workers = record(list.ok ? list.result : undefined).workers
    const listed = (Array.isArray(workers) ? workers : [])
      .map(record)
      .find((worker) => worker.dispatchId === 'ctx_b1')
    expect({
      state: record(shown.worker).state,
      asOf: record(shown.server).asOf
    }).toEqual({ state: listed?.workerState, asOf: record(listed?.server).asOf })
  })

  it("gives up a worker-read within seconds when the server sleeps, in the server's terms", async () => {
    await startOnB()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    sleeping = true
    let read: RpcResponse | undefined
    void call('orchestration.workerRead', { dispatch: 'ctx_b1' }).then((answer) => {
      read = answer
    })
    await vi.advanceTimersByTimeAsync(10_000)
    vi.useRealTimers()

    expect(read?.ok ? undefined : read?.error.code).toBe('runtime_timeout')
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

  it('owes a stop the server did not answer and says so', async () => {
    await startOnB()
    const stop = await call('orchestration.workerStop', { dispatch: 'ctx_b1' })

    expect(stop.ok ? stop.result : undefined).toMatchObject({ state: 'stop_requested' })
    expect(getRemoteDispatch(db, 'ctx_b1')).toMatchObject({ stop_owed: 1 })
  })

  it("updates this Orca's own Task here by the local rule, and never sends the update to its server", async () => {
    const { taskId, runId } = await startOnB()
    importState(runId, taskId, 1, {
      status: 'dispatched',
      workerState: 'ready',
      taskStatus: 'dispatched'
    })

    const held = await call('orchestration.taskUpdate', {
      id: taskId,
      status: 'completed',
      result: 'by hand',
      callerTerminalHandle: 'term_coord'
    })
    expect(held.ok ? undefined : held.error.message).toContain(
      `Task ${taskId} cannot move to completed while supervised Dispatch ctx_b1 is active`
    )

    await call('orchestration.workerStop', { dispatch: 'ctx_b1' })
    const updated = await call('orchestration.taskUpdate', {
      id: taskId,
      status: 'failed',
      result: 'given up',
      callerTerminalHandle: 'term_coord'
    })
    expect(updated.ok).toBe(true)
    expect(db.getTask(taskId)?.status).toBe('failed')
    expect(sent.map((s) => s.method)).not.toContain('orchestration.taskUpdate')
  })

  it('fails the Task a worker held when its pairing is re-made, with the reason', async () => {
    const { taskId, runId } = await startOnB()
    server = { ...server, homePeerFingerprint: 'cred_a_new', pairingRevision: 2 }

    await call('orchestration.workerRead', { dispatch: 'ctx_b1' })
    expect(db.getTask(taskId)).toMatchObject({
      status: 'failed',
      result: 'The pairing with devB was re-made. Its worker may still run there.'
    })
    // As a local worker's failure, the Run's coordinator is told.
    expect(
      db.db
        .prepare(`SELECT type, body FROM messages WHERE to_handle = ? AND type = 'escalation'`)
        .get(`run:${runId}`)
    ).toMatchObject({ body: expect.stringContaining('The pairing with devB was re-made.') })
  })

  it('fails the Task a worker held when its pairing is re-made, with no call through its link', async () => {
    const { taskId, runId } = await startOnB()
    runtime.ensureOrchestrationFederationRelay(runId)
    server = { ...server, homePeerFingerprint: 'cred_a_new', pairingRevision: 2 }

    await vi.waitFor(() =>
      expect(db.getTask(taskId)).toMatchObject({
        status: 'failed',
        result: 'The pairing with devB was re-made. Its worker may still run there.'
      })
    )
  })

  it('refuses here to start a Task placed through an earlier pairing, and a new Task starts there', async () => {
    const { taskId } = await startOnB()
    server = { ...server, homePeerFingerprint: 'cred_a_new', pairingRevision: 2 }
    await call('orchestration.workerRead', { dispatch: 'ctx_b1' })
    await call('orchestration.taskUpdate', {
      id: taskId,
      status: 'ready',
      callerTerminalHandle: 'term_coord'
    })
    const startsBefore = sent.filter((s) => s.method === 'orchestration.workerStart').length

    answers['orchestration.workerStart'] = [started('ctx_b2')]
    const again = await call('orchestration.workerStart', {
      from: 'term_coord',
      on: 'devB',
      task: taskId,
      worktree: 'new-top-level'
    })
    expect(again.ok ? undefined : again.error.message).toBe(
      `Task ${taskId} was placed through a pairing with devB that was re-made or removed; create a new task to run it there. No effects were applied.`
    )
    expect(sent.filter((s) => s.method === 'orchestration.workerStart')).toHaveLength(startsBefore)

    const fresh = await call('orchestration.workerStart', {
      from: 'term_coord',
      on: 'devB',
      spec: 'build it again',
      worktree: 'new-top-level'
    })
    expect(fresh.ok ? undefined : fresh.error.message).toBeUndefined()
  })

  it("lists a Run's workers on its server by the server's Run after a re-pair closed the link", async () => {
    const { taskId, runId } = await startOnB()
    importState(runId, taskId, 1, {
      status: 'dispatched',
      workerState: 'ready',
      taskStatus: 'dispatched'
    })
    server = { ...server, homePeerFingerprint: 'cred_a_new', pairingRevision: 2 }
    await call('orchestration.workerRead', { dispatch: 'ctx_b1' })
    // A refused start opens the Run's next link, which no server Run answers for yet.
    await call('orchestration.taskUpdate', {
      id: taskId,
      status: 'ready',
      callerTerminalHandle: 'term_coord'
    })
    const refused = await call('orchestration.workerStart', {
      from: 'term_coord',
      on: 'devB',
      task: taskId,
      worktree: 'new-top-level'
    })
    expect(refused.ok).toBe(false)
    answers['orchestration.workerList'] = [
      {
        result: {
          workers: [{ dispatchId: 'ctx_b1', runId: 'run_on_b' }],
          page: { total: 1, hasMore: false, nextCursor: null }
        }
      }
    ]

    const listed = await call('orchestration.workerList', { on: 'devB', run: runId })
    expect(listed.ok ? undefined : listed.error).toBeUndefined()
    expect(sent.findLast((s) => s.method === 'orchestration.workerList')?.params).toMatchObject({
      run: 'run_on_b'
    })
  })

  it("readies the Task here when the server's restart lost its worker, even after a stop it never proved", async () => {
    const { taskId, runId } = await startOnB()
    importState(runId, taskId, 1, {
      status: 'dispatched',
      workerState: 'ready',
      taskStatus: 'dispatched'
    })
    await call('orchestration.workerStop', { dispatch: 'ctx_b1' })
    expect(db.getTask(taskId)?.status).toBe('blocked')

    importState(runId, taskId, 2, {
      status: 'failed',
      workerState: 'abandoned',
      taskStatus: 'ready'
    })
    expect(db.getTask(taskId)?.status).toBe('ready')
  })

  it('fails the Task a worker held once its server is removed from this Orca', async () => {
    const { taskId, runId } = await startOnB()
    paired = false
    runtime.ensureOrchestrationFederationRelay(runId)

    await vi.waitFor(() =>
      expect(db.getTask(taskId)).toMatchObject({
        status: 'failed',
        result: "devB was removed from this Orca's paired servers. Its worker may still run there."
      })
    )
  })

  it('sends a stop it owes as soon as its server answers again, not after its backoff', async () => {
    const { taskId, runId } = await startOnB()
    importState(runId, taskId, 1, {
      status: 'dispatched',
      workerState: 'ready',
      taskStatus: 'dispatched'
    })
    await call('orchestration.workerStop', { dispatch: 'ctx_b1' })
    db.db.prepare('UPDATE remote_dispatches SET stop_retry_at = ?').run(Date.now() + 600_000)
    const stops = () => sent.filter((s) => s.method === 'orchestration.workerStop').length
    const before = stops()

    answers['orchestration.workerStop'] = [{ result: { state: 'stopped', alreadySettled: false } }]
    pullFailures = 1
    await vi.waitFor(() => expect(stops()).toBe(before + 1), { timeout: 8_000 })
  })

  /** devB's queue item saying where its Dispatch and Task now stand. */
  function importState(
    runId: string,
    taskId: string,
    sequence: number,
    state: { status: string; workerState: string; taskStatus: string; result?: string }
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
        removed: null
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
