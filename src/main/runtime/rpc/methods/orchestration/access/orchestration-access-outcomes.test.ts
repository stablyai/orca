import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { eraseRpcMethods, type RpcResponse } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'

const PANES: Record<string, string> = {
  term_owner: 'tab_owner:11111111-1111-4111-8111-111111111111',
  term_other: 'tab_other:22222222-2222-4222-8222-222222222222',
  term_lone: 'tab_lone:33333333-3333-4333-8333-333333333333',
  term_worker: 'tab_worker:44444444-4444-4444-8444-444444444444',
  term_helper: 'tab_helper:55555555-5555-4555-8555-555555555555'
}

/** Two Runs, a dispatched Task with a worker, a question to the Run, a helper's question to that worker, a gate and plain mail. */
async function createFixture() {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => PANES[handle] ?? null)
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) => PANES[handle] ?? null)
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    PANES[handle] ? `process:${handle}` : null
  )
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  // Startup recovery runs on the first call; seed after it so it cannot settle the fixture's workers.
  await dispatcher.dispatch({
    id: 'rpc_warm',
    authToken: 'token',
    method: 'orchestration.runList',
    params: {},
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
  })
  const owned = db.createRun({
    objective: 'owned',
    coordinatorHandle: 'term_owner',
    coordinatorPaneKey: PANES.term_owner
  })
  const foreign = db.createRun({
    objective: 'foreign',
    coordinatorHandle: 'term_other',
    coordinatorPaneKey: PANES.term_other
  })
  const task = db.createTask({ runId: owned.id, spec: 'work' })
  const dispatch = createRootDispatch(
    db,
    task.id,
    'term_worker',
    PANES.term_worker,
    undefined,
    'process:term_worker'
  )
  const helperTask = db.createTask({ runId: owned.id, spec: 'helper work' })
  const helper = createRootDispatch(
    db,
    helperTask.id,
    'term_helper',
    PANES.term_helper,
    undefined,
    'process:term_helper'
  )
  const question = db.createQuestion({
    runId: owned.id,
    dispatchId: dispatch.id,
    askerHandle: 'term_worker',
    question: 'Which way?'
  }).message
  const helperQuestion = db.createQuestion({
    runId: owned.id,
    dispatchId: helper.id,
    askerHandle: 'term_helper',
    question: 'Helper asks its creator',
    to: `dispatch:${dispatch.id}`
  }).message
  const mail = db.insertMessage({
    from: 'term_lone',
    to: 'term_owner',
    subject: 'hello',
    body: 'plain mail',
    runId: owned.id
  })
  const readyTask = db.createTask({ runId: owned.id, spec: 'ready work' })
  const foreignTask = db.createTask({ runId: foreign.id, spec: 'foreign work' })
  // A gate on the dispatched Task would settle its Dispatch.
  const gate = db.createGate({ taskId: readyTask.id, question: 'Proceed?' })
  const ids = {
    owned: owned.id,
    foreign: foreign.id,
    task: task.id,
    readyTask: readyTask.id,
    foreignTask: foreignTask.id,
    dispatch: dispatch.id,
    question: question.id,
    helperQuestion: helperQuestion.id,
    mail: mail.id,
    gate: gate.id
  }
  return { db, runtime, ids, dispatcher }
}

type Ids = Awaited<ReturnType<typeof createFixture>>['ids']
type Case = { method: string; params: (caller: string, ids: Ids) => unknown }

/** One call per method (several where its own rule has several paths), each made by every caller. */
const CASES = {
  ask: {
    method: 'orchestration.ask',
    params: (from) => ({ to: 'term_lone', question: 'q', wait: false, from })
  },
  callerShow: { method: 'orchestration.callerShow', params: () => undefined },
  check: { method: 'orchestration.check', params: (terminal) => ({ terminal }) },
  checkRun: {
    method: 'orchestration.check',
    params: (terminal, ids) => ({ terminal, run: ids.owned, peek: true })
  },
  crewSubscribe: {
    method: 'orchestration.crewSubscribe',
    params: (address) => ({ party: { address } })
  },
  dispatch: {
    method: 'orchestration.dispatch',
    params: (from, ids) => ({ task: ids.readyTask, to: 'term_lone', from, dryRun: true })
  },
  dispatchForeign: {
    method: 'orchestration.dispatch',
    params: (from, ids) => ({ task: ids.foreignTask, to: 'term_lone', from, dryRun: true })
  },
  dispatchShow: {
    method: 'orchestration.dispatchShow',
    params: (from, ids) => ({ task: ids.task, from })
  },
  federationAck: {
    method: 'orchestration.federationAck',
    params: (_, ids) => ({ dispatchId: ids.dispatch, throughSequence: 0 })
  },
  federationAttachStart: {
    method: 'orchestration.federationAttachStart',
    params: (_, ids) => ({
      dispatchId: ids.dispatch,
      taskId: ids.task,
      taskSpec: 'work',
      protocolVersion: 3,
      worktree: 'current'
    })
  },
  federationFleetSnapshot: {
    method: 'orchestration.federationFleetSnapshot',
    params: (_, ids) => ({ dispatchIds: [ids.dispatch] })
  },
  federationImport: {
    method: 'orchestration.federationImport',
    params: (_, ids) => ({ dispatchId: ids.dispatch, items: [] })
  },
  federationPull: {
    method: 'orchestration.federationPull',
    params: (_, ids) => ({ dispatchId: ids.dispatch })
  },
  federationRead: {
    method: 'orchestration.federationRead',
    params: (_, ids) => ({ dispatchId: ids.dispatch })
  },
  federationReadOutput: {
    method: 'orchestration.federationReadOutput',
    params: (_, ids) => ({ dispatchId: ids.dispatch })
  },
  federationRelease: {
    method: 'orchestration.federationRelease',
    params: (_, ids) => ({ dispatchId: ids.dispatch })
  },
  federationRetain: {
    method: 'orchestration.federationRetain',
    params: (_, ids) => ({ dispatchId: ids.dispatch })
  },
  federationShow: {
    method: 'orchestration.federationShow',
    params: (_, ids) => ({ dispatchId: ids.dispatch })
  },
  federationStop: {
    method: 'orchestration.federationStop',
    params: (_, ids) => ({ dispatchId: ids.dispatch })
  },
  gateCreate: {
    method: 'orchestration.gateCreate',
    params: (from, ids) => ({ task: ids.task, question: 'q', from })
  },
  gateCreateBadOptions: {
    method: 'orchestration.gateCreate',
    params: (from, ids) => ({ task: ids.task, question: 'q', options: 'not json', from })
  },
  gateCreateForeign: {
    method: 'orchestration.gateCreate',
    params: (from, ids) => ({ task: ids.foreignTask, question: 'q', from })
  },
  gateList: { method: 'orchestration.gateList', params: (from) => ({ from }) },
  gateListRun: {
    method: 'orchestration.gateList',
    params: (from, ids) => ({ from, run: ids.owned })
  },
  gateResolve: {
    method: 'orchestration.gateResolve',
    params: (from, ids) => ({ id: ids.gate, resolution: 'yes', from })
  },
  inbox: { method: 'orchestration.inbox', params: (terminal) => ({ terminal }) },
  partyLocation: { method: 'orchestration.partyLocation', params: (address) => ({ address }) },
  partyOpen: { method: 'orchestration.partyOpen', params: (address) => ({ address }) },
  peerMailAck: { method: 'orchestration.peerMailAck', params: () => ({ acknowledgments: [] }) },
  peerMailDeliver: {
    method: 'orchestration.peerMailDeliver',
    params: (to) => ({
      conversationId: 'peerconv_x',
      messageId: 'msg_peer',
      to,
      senderLabel: 'A',
      subject: 's'
    })
  },
  peerMailPull: { method: 'orchestration.peerMailPull', params: () => ({ waitMs: 0 }) },
  peerRunCancel: { method: 'orchestration.peerRunCancel', params: () => ({}) },
  replyHelperQuestion: {
    method: 'orchestration.reply',
    params: (from, ids) => ({ id: ids.helperQuestion, body: 'a', from })
  },
  replyMail: {
    method: 'orchestration.reply',
    params: (from, ids) => ({ id: ids.mail, body: 'a', from })
  },
  replyQuestion: {
    method: 'orchestration.reply',
    params: (from, ids) => ({ id: ids.question, body: 'a', from })
  },
  replyQuestionOtherRun: {
    method: 'orchestration.reply',
    params: (from, ids) => ({ id: ids.question, body: 'a', from, run: ids.foreign })
  },
  requestShow: { method: 'orchestration.requestShow', params: () => ({ request: 'req_unknown' }) },
  reset: { method: 'orchestration.reset', params: () => ({ messages: true }) },
  run: { method: 'orchestration.run', params: (from) => ({ spec: 's', from }) },
  runCreate: { method: 'orchestration.runCreate', params: (from) => ({ objective: 'o', from }) },
  runCurrent: { method: 'orchestration.runCurrent', params: (from) => ({ from }) },
  runList: { method: 'orchestration.runList', params: () => ({}) },
  runShow: { method: 'orchestration.runShow', params: (from, ids) => ({ id: ids.owned, from }) },
  runStop: { method: 'orchestration.runStop', params: () => ({}) },
  runUse: { method: 'orchestration.runUse', params: (from, ids) => ({ id: ids.owned, from }) },
  send: {
    method: 'orchestration.send',
    params: (from) => ({ to: 'term_lone', subject: 's', body: 'b', from })
  },
  sessionAddress: {
    method: 'orchestration.sessionAddress',
    params: () => ({ sessionId: 'not-a-session' })
  },
  taskCreate: {
    method: 'orchestration.taskCreate',
    params: (callerTerminalHandle) => ({ spec: 's', callerTerminalHandle })
  },
  taskCreateBadDeps: {
    method: 'orchestration.taskCreate',
    params: (callerTerminalHandle) => ({ spec: 's', deps: 'not json', callerTerminalHandle })
  },
  taskCreateOtherRun: {
    method: 'orchestration.taskCreate',
    params: (callerTerminalHandle, ids) => ({ spec: 's', callerTerminalHandle, run: ids.foreign })
  },
  taskList: {
    method: 'orchestration.taskList',
    params: (callerTerminalHandle) => ({ callerTerminalHandle })
  },
  taskListRun: {
    method: 'orchestration.taskList',
    params: (callerTerminalHandle, ids) => ({ callerTerminalHandle, run: ids.foreign })
  },
  taskUpdate: {
    method: 'orchestration.taskUpdate',
    params: (callerTerminalHandle, ids) => ({
      id: ids.readyTask,
      status: 'blocked',
      callerTerminalHandle
    })
  },
  taskUpdateForeign: {
    method: 'orchestration.taskUpdate',
    params: (callerTerminalHandle, ids) => ({
      id: ids.foreignTask,
      status: 'blocked',
      callerTerminalHandle
    })
  },
  workerAbandon: {
    method: 'orchestration.workerAbandon',
    params: (_, ids) => ({ dispatch: ids.dispatch })
  },
  workerAutoClose: {
    method: 'orchestration.workerAutoClose',
    params: () => ({ terminal: 'term_worker' })
  },
  workerChatTouch: {
    method: 'orchestration.workerChatTouch',
    params: () => ({ terminal: 'term_worker' })
  },
  workerKeepOpen: {
    method: 'orchestration.workerKeepOpen',
    params: () => ({ terminal: 'term_worker', keep: true })
  },
  workerList: { method: 'orchestration.workerList', params: () => ({}) },
  workerRead: {
    method: 'orchestration.workerRead',
    params: (_, ids) => ({ dispatch: ids.dispatch })
  },
  workerRelease: {
    method: 'orchestration.workerRelease',
    params: (_, ids) => ({ dispatch: ids.dispatch })
  },
  workerRetain: {
    method: 'orchestration.workerRetain',
    params: (_, ids) => ({ dispatch: ids.dispatch })
  },
  workerShow: {
    method: 'orchestration.workerShow',
    params: (_, ids) => ({ dispatch: ids.dispatch })
  },
  workerStart: {
    method: 'orchestration.workerStart',
    params: (from) => ({ task: 'task_missing', from })
  },
  workerStop: {
    method: 'orchestration.workerStop',
    params: (_, ids) => ({ dispatch: ids.dispatch })
  },
  workerTerminalUserInput: {
    method: 'orchestration.workerTerminalUserInput',
    params: () => ({ terminal: 'term_worker' })
  }
}

/** Recorded on main before the access check existed; every row must stay the same. Callers: term_owner, term_other, term_lone, term_worker. */
const EXPECTED: Record<string, string> & Record<keyof typeof CASES, string> = {
  ask: 'dispatch_inactive dispatch_inactive dispatch_inactive dispatch_run_mismatch',
  callerShow: 'ok ok ok ok',
  check: 'ok ok ok ok',
  checkRun: 'ok consumer_fenced consumer_fenced worker_cannot_coordinate_own_run',
  crewSubscribe: 'invalid_argument invalid_argument invalid_argument invalid_argument',
  dispatch: 'ok task_not_found run_required run_required',
  dispatchForeign: 'task_not_found ok run_required run_required',
  dispatchShow: 'ok ok ok ok',
  federationAck: 'dispatch_not_found dispatch_not_found dispatch_not_found dispatch_not_found',
  federationAttachStart: 'invalid_argument invalid_argument invalid_argument invalid_argument',
  federationFleetSnapshot: 'ok ok ok ok',
  federationImport: 'dispatch_not_found dispatch_not_found dispatch_not_found dispatch_not_found',
  federationPull: 'dispatch_not_found dispatch_not_found dispatch_not_found dispatch_not_found',
  federationRead: 'dispatch_not_found dispatch_not_found dispatch_not_found dispatch_not_found',
  federationReadOutput:
    'dispatch_not_found dispatch_not_found dispatch_not_found dispatch_not_found',
  federationRelease: 'dispatch_not_found dispatch_not_found dispatch_not_found dispatch_not_found',
  federationRetain: 'dispatch_not_found dispatch_not_found dispatch_not_found dispatch_not_found',
  federationShow: 'dispatch_not_found dispatch_not_found dispatch_not_found dispatch_not_found',
  federationStop: 'dispatch_not_found dispatch_not_found dispatch_not_found dispatch_not_found',
  gateCreate: 'ok task_not_found run_required run_required',
  gateCreateBadOptions: 'runtime_error runtime_error runtime_error runtime_error',
  gateCreateForeign: 'task_not_found ok run_required run_required',
  gateList: 'ok ok run_required run_required',
  gateListRun: 'ok ok ok ok',
  gateResolve: 'ok runtime_error run_required run_required',
  inbox: 'ok ok ok ok',
  partyLocation: 'ok ok ok ok',
  partyOpen: 'ok ok ok ok',
  peerMailAck:
    'mail_requires_server_pairing mail_requires_server_pairing mail_requires_server_pairing mail_requires_server_pairing',
  peerMailDeliver:
    'mail_requires_server_pairing mail_requires_server_pairing mail_requires_server_pairing mail_requires_server_pairing',
  peerMailPull:
    'mail_requires_server_pairing mail_requires_server_pairing mail_requires_server_pairing mail_requires_server_pairing',
  peerRunCancel: 'forbidden forbidden forbidden forbidden',
  replyHelperQuestion: 'ok consumer_fenced consumer_fenced ok',
  replyMail: 'ok ok ok ok',
  replyQuestion: 'ok consumer_fenced consumer_fenced worker_cannot_coordinate_own_run',
  replyQuestionOtherRun: 'consumer_fenced question_not_found consumer_fenced consumer_fenced',
  requestShow: 'ok ok ok ok',
  reset: 'ok ok ok ok',
  run: 'orchestration_migration_required orchestration_migration_required orchestration_migration_required orchestration_migration_required',
  runCreate: 'ok ok ok ok',
  runCurrent: 'ok ok ok ok',
  runList: 'ok ok ok ok',
  runShow: 'ok ok ok ok',
  runStop:
    'orchestration_migration_required orchestration_migration_required orchestration_migration_required orchestration_migration_required',
  runUse: 'ok ok ok worker_cannot_coordinate_own_run',
  send: 'ok ok ok ok',
  sessionAddress: 'ok ok ok ok',
  taskCreate: 'ok ok run_required run_required',
  taskCreateBadDeps: 'runtime_error runtime_error runtime_error runtime_error',
  taskCreateOtherRun: 'consumer_fenced ok consumer_fenced consumer_fenced',
  taskList: 'ok ok run_required run_required',
  taskListRun: 'ok ok ok ok',
  taskUpdate: 'ok task_not_found run_required run_required',
  taskUpdateForeign: 'task_not_found ok run_required run_required',
  workerAbandon: 'ok ok ok ok',
  workerAutoClose: 'ok ok ok ok',
  workerChatTouch: 'ok ok ok ok',
  workerKeepOpen: 'ok ok ok ok',
  workerList: 'ok ok ok ok',
  workerRead:
    'worker_identity_changed worker_identity_changed worker_identity_changed worker_identity_changed',
  workerRelease: 'dispatch_inactive dispatch_inactive dispatch_inactive dispatch_inactive',
  workerRetain: 'dispatch_inactive dispatch_inactive dispatch_inactive dispatch_inactive',
  workerShow: 'ok ok ok ok',
  workerStart: 'task_not_found task_not_found consumer_fenced task_not_found',
  workerStop: 'ok ok ok ok',
  workerTerminalUserInput: 'ok ok ok ok'
}

const CALLERS = ['term_owner', 'term_other', 'term_lone', 'term_worker'] as const

async function outcome({ method, params }: Case, caller: string): Promise<string> {
  const { db, dispatcher, ids } = await createFixture()
  try {
    const response: RpcResponse = await dispatcher.dispatch({
      id: `rpc_${method}`,
      authToken: 'token',
      method,
      params: params(caller, ids),
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
    })
    return response.ok ? 'ok' : response.error.code
  } finally {
    db.close()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('orchestration access outcomes', () => {
  it('covers every orchestration method', () => {
    const covered = new Set(Object.values(CASES).map((entry) => entry.method))
    const methods = eraseRpcMethods(ORCHESTRATION_METHODS).map((method) => method.name)
    expect(methods.filter((method) => !covered.has(method))).toEqual([])
  })

  it.each(Object.entries(CASES))(
    '%s keeps its allow/refuse outcome for every caller',
    async (name, entry: Case) => {
      const row: string[] = []
      for (const caller of CALLERS) {
        row.push(await outcome(entry, caller))
      }
      expect(row.join(' ')).toBe(EXPECTED[name])
    },
    // The first call starts lazy host setup.
    30_000
  )
})

describe('orchestration access on replay', () => {
  it('replays an accepted reply after its caller loses the Run, refusing only new requests', async () => {
    const { db, dispatcher, ids } = await createFixture()
    try {
      const reply = (requestId: string) =>
        dispatcher.dispatch({
          id: `rpc_${requestId}`,
          authToken: 'token',
          method: 'orchestration.reply',
          params: { id: ids.question, body: 'go left', from: 'term_owner' },
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
          orchestrationRequestId: requestId
        })
      const accepted = await reply('req_answer')
      expect(accepted).toMatchObject({ ok: true })
      // Another terminal now coordinates the Run.
      db.db
        .prepare('UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ? WHERE id = ?')
        .run('term_lone', PANES.term_lone, ids.owned)
      expect(await reply('req_new')).toMatchObject({
        ok: false,
        error: { code: 'consumer_fenced' }
      })
      const answer = db.getQuestion(ids.question)?.answer_message_id
      expect(answer).toBeTruthy()
      expect(await reply('req_answer')).toMatchObject({
        ok: true,
        result: { message: { id: answer }, mutation: { replayed: true } }
      })
    } finally {
      db.close()
    }
  })
})
