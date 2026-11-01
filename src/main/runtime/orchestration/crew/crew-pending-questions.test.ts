import { expect, it } from 'vitest'
import { fixture } from './crew-read-model.test-fixture'
import { buildCrewSnapshot } from './crew-read-model'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'

// Ages the clock from the writers' actual timestamps, so the cutoff lands just past them.
function agedWriterClock(previousMaximum: number | undefined, ...timestamps: string[]) {
  const maximum = Math.max(previousMaximum ?? -Infinity, ...timestamps.map(Date.parse))
  const cutoff = maximum + 1
  return { maximum, now: cutoff + AGENT_STATUS_STALE_AFTER_MS, cutoff }
}

it('decorates handed-back peer questions after row creation without flattening direct children', () => {
  const { db, deps, run, assign } = fixture()
  const parent = assign('term_worker')
  const helper = assign('term_helper', 'term_worker')
  const question = db.createQuestion({
    runId: run.id,
    dispatchId: helper.id,
    askerHandle: 'term_helper',
    to: `dispatch:${parent.id}`,
    question: 'Choose the helper option?'
  })
  db.completeDispatch(parent.id)
  expect(db.getMessageById(question.message.id)?.to_handle).toBe(`run:${run.id}`)
  const snapshot = buildCrewSnapshot('term_coord', deps)
  expect(snapshot.sections.managing.map((row) => row.sendAddress)).toEqual(['term_worker'])
  expect(snapshot.sections.talkingWith).toHaveLength(1)
  expect(snapshot.sections.talkingWith[0].pendingQuestion?.preview).toBe(
    'Choose the helper option?'
  )
  expect(db.getQuestion(question.message.id)?.status).toBe('pending')
})

it('keeps true traffic cutoff independent of pending membership and excludes self', () => {
  const f = fixture()
  const self = f.assign('term_coord')
  const helper = f.assign('term_helper', 'term_worker')
  const pending = f.db.createQuestion({
    runId: f.run.id,
    dispatchId: helper.id,
    askerHandle: 'term_helper',
    question: 'attention survives cutoff'
  })
  f.db.createQuestion({
    runId: f.run.id,
    dispatchId: self.id,
    askerHandle: 'term_coord',
    question: 'not my own peer'
  })
  const at = Date.parse(pending.message.created_at)
  const read = (now: number) => buildCrewSnapshot('term_coord', { ...f.deps, now })
  const boundary = read(at + AGENT_STATUS_STALE_AFTER_MS)
  const rowAt = boundary.sections.talkingWith.find(
    (row) => row.pendingQuestion?.preview === 'attention survives cutoff'
  )
  expect(rowAt?.latest?.sequence).toBe(pending.message.sequence)
  const aged = read(at + AGENT_STATUS_STALE_AFTER_MS + 1)
  const rowAfter = aged.sections.talkingWith.find(
    (row) => row.pendingQuestion?.preview === 'attention survives cutoff'
  )
  expect(rowAfter).toHaveProperty('pendingQuestion')
  expect(rowAfter).not.toHaveProperty('latest')
  expect(
    Object.values(aged.sections)
      .flat()
      .some((row) => row.partyKey.endsWith('term_coord"]'))
  ).toBe(false)
})

it('folds pending representatives across committed clear aliases without fabricating Latest', () => {
  const f = fixture()
  const root = testOrcaSessionId('chat-pending-root')
  const next = testOrcaSessionId('chat-pending-next')
  const records = [
    agentSessionConversationView(
      agentSessionRecordFixture({
        sessionId: root,
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          callerKey: 'pending-clear',
          phase: 'committed',
          replacementSessionId: next,
          operationId: 'pending-clear-one'
        }
      })
    ),
    agentSessionConversationView(agentSessionRecordFixture({ sessionId: next }))
  ]
  f.deps.records = {
    listRecords: () => records,
    getRecord: (id) => records.find((record) => record.sessionId === id) ?? null,
    getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [next] })
  }
  const questions = [root, next].map((id) => {
    const dispatch = f.assign(`orca_session_id:${id}`, 'term_worker')
    return f.db.createQuestion({
      runId: f.run.id,
      dispatchId: dispatch.id,
      askerHandle: `orca_session_id:${id}`,
      question: `pending ${id}`
    })
  })
  let aged = agedWriterClock(undefined, ...questions.map(({ message }) => message.created_at))
  let now = aged.now
  const snapshot = () => buildCrewSnapshot('term_coord', { ...f.deps, now })
  let peers = snapshot().sections.talkingWith
  expect(peers).toHaveLength(1)
  expect(peers[0]).toMatchObject({
    partyKey: JSON.stringify(['test-host', `orca_session_id:${root}`]),
    pendingQuestion: { preview: `pending ${next}` },
    openTarget: { kind: 'chat', sessionId: next }
  })
  expect(peers[0]).not.toHaveProperty('latest')
  const answer = f.db.answerQuestion({
    messageId: questions[1].message.id,
    runId: f.run.id,
    consumerGeneration: f.run.consumer_generation,
    body: 'answered representative'
  })
  aged = agedWriterClock(aged.maximum, answer.message.created_at)
  now = aged.now
  peers = snapshot().sections.talkingWith
  expect(peers).toHaveLength(1)
  expect(peers[0].pendingQuestion?.preview).toBe(`pending ${root}`)
  expect(peers[0]).not.toHaveProperty('latest')
})
