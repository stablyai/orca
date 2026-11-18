import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'

const PANES: Record<string, string> = {
  term_owner: 'tab_owner:11111111-1111-4111-8111-111111111111',
  term_lone: 'tab_lone:33333333-3333-4333-8333-333333333333',
  term_worker: 'tab_worker:44444444-4444-4444-8444-444444444444'
}

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
  const task = db.createTask({ runId: owned.id, spec: 'work' })
  const dispatch = createRootDispatch(
    db,
    task.id,
    'term_worker',
    PANES.term_worker,
    undefined,
    'process:term_worker'
  )
  const question = db.createQuestion({
    runId: owned.id,
    dispatchId: dispatch.id,
    askerHandle: 'term_worker',
    question: 'Which way?'
  }).message
  const ids = { owned: owned.id, question: question.id }
  return { db, runtime, ids, dispatcher }
}

afterEach(() => {
  vi.restoreAllMocks()
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
