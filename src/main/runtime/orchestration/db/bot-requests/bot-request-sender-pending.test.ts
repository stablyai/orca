import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  forgetPeerQuestionOut,
  recordPeerHandoffOut,
  recordPeerQuestionOut,
  settlePeerQuestionsOut,
  tellUnpairedPeerQuestions
} from '../../federation/peer-mail/peer-questions-out'
import { storePeerReply } from '../../federation/peer-mail/peer-reply-store'
import { OrchestrationDb } from '../orchestration-db'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { sessionAwaitsMail, sessionAwaitsMailSql } from './bot-request-sender-pending'

// A finished run chat closes only once nothing it asked is owed back: an open local bot request
// from it, or a question or handoff still out on a paired computer, keeps it, across a restart.

let directory = ''
let db: OrchestrationDb
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-bot-request-sender-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function ask(from: string, purpose: 'status' | 'handoff' | 'question'): string {
  const admitted = db.admitBotRequest({
    rootKey: `${from}-${purpose}`,
    fromBotId: 'asker',
    toBotId: 'helper',
    purpose,
    depth: 1,
    record: '{}',
    message: { from: `orca_session_id:${from}`, to: 'bot:helper', subject: 'Hi', type: purpose }
  })
  if (admitted.kind !== 'sent') {
    throw new Error(admitted.kind)
  }
  return admitted.message.id
}

it('a chat waits on mail from its open requests, paired asks and undelivered mail, until each ends', () => {
  ask('status-only', 'status')
  const question = ask('root', 'question')
  const handoff = ask('live', 'handoff')
  recordPeerQuestionOut(db, {
    messageId: 'msg_peer',
    conversationId: 'conversation',
    environmentId: 'server',
    peerFingerprint: 'fingerprint',
    asker: 'orca_session_id:paired'
  })

  expect(sessionAwaitsMail(db, ['status-only'])).toBe(false)
  // A /clear moved the chat on: its first id and the live one both count.
  expect(sessionAwaitsMail(db, ['root', 'live'])).toBe(true)
  db.recordBotRequestOutcome(question, 'answered')
  expect(sessionAwaitsMail(db, ['root'])).toBe(false)
  expect(sessionAwaitsMail(db, ['root', 'live'])).toBe(true)
  expect(sessionAwaitsMail(db, ['paired'])).toBe(true)

  db.close()
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  expect(sessionAwaitsMail(db, ['live'])).toBe(true)
  expect(sessionAwaitsMail(db, ['paired'])).toBe(true)
  db.recordBotRequestOutcome(handoff, 'unanswered')
  db.db.prepare('UPDATE peer_questions_out SET awaiting = NULL').run()
  expect(sessionAwaitsMail(db, ['live', 'paired'])).toBe(false)

  // A question and a handoff in one thread to a paired computer: a reply naming one settles that
  // one; an older paired Orca's reply, naming none, settles one ask, the oldest question first.
  const paired = {
    conversationId: 'conversation',
    environmentId: 'server',
    peerFingerprint: 'fingerprint',
    asker: 'orca_session_id:questioning',
    threadId: 'msg_pq_1'
  }
  recordPeerQuestionOut(db, { ...paired, messageId: 'msg_pq_1' })
  recordPeerHandoffOut(db, { ...paired, messageId: 'msg_ph_1' })
  settlePeerQuestionsOut(db, 'conversation', { threadId: 'msg_pq_1', replyTo: 'msg_ph_1' })
  expect(sessionAwaitsMail(db, ['questioning'])).toBe(true)
  settlePeerQuestionsOut(db, 'conversation', { threadId: 'msg_pq_1', replyTo: 'msg_pq_1' })
  expect(sessionAwaitsMail(db, ['questioning'])).toBe(false)
  recordPeerQuestionOut(db, { ...paired, messageId: 'msg_pq_2' })
  recordPeerHandoffOut(db, { ...paired, messageId: 'msg_ph_2' })
  for (const expected of [true, false]) {
    settlePeerQuestionsOut(db, 'conversation', { threadId: 'msg_pq_1' })
    expect(sessionAwaitsMail(db, ['questioning'])).toBe(expected)
  }

  // A handoff to a paired computer holds its chat until the answer comes back, the send fails, or
  // the pairing ends.
  const handOff = (messageId: string, threadId?: string) =>
    recordPeerHandoffOut(db, {
      messageId,
      conversationId: 'conversation',
      environmentId: 'server',
      peerFingerprint: 'fingerprint',
      asker: 'orca_session_id:handing',
      threadId
    })
  handOff('msg_handoff')
  handOff('msg_handoff_2', 'msg_handoff')
  expect(sessionAwaitsMail(db, ['handing'])).toBe(true)
  // A reply naming only its thread (an ordinary chat's, or an older paired Orca's) settles one.
  settlePeerQuestionsOut(db, 'conversation', { threadId: 'msg_handoff' })
  expect(sessionAwaitsMail(db, ['handing'])).toBe(true)
  settlePeerQuestionsOut(db, 'conversation', { threadId: 'msg_handoff' })
  expect(sessionAwaitsMail(db, ['handing'])).toBe(false)
  handOff('msg_failed')
  forgetPeerQuestionOut(db, 'msg_failed')
  expect(sessionAwaitsMail(db, ['handing'])).toBe(false)
  handOff('msg_unpaired')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no question awaits, so only the absent closer is read from the runtime.
  tellUnpairedPeerQuestions({} as never, db, {
    environmentId: 'server',
    serverName: 'Server',
    reason: 'Removed.'
  })
  expect(sessionAwaitsMail(db, ['handing'])).toBe(false)

  // An answer stored but not yet handed to the chat.
  const answer = db.insertMessage({
    from: 'bot:helper',
    to: 'orca_session_id:live',
    subject: 'Re: Hi'
  })
  expect(sessionAwaitsMail(db, ['live'])).toBe(true)
  db.db.prepare("UPDATE messages SET delivered_at = datetime('now') WHERE id = ?").run(answer.id)
  expect(sessionAwaitsMail(db, ['live'])).toBe(false)

  // An ask of an ordinary chat is owed until a reply names it, wherever that reply is routed.
  const delivered = (id: string) =>
    db.db.prepare("UPDATE messages SET delivered_at = datetime('now') WHERE id = ?").run(id)
  const send = (fields: Parameters<typeof db.insertMessage>[0]) => {
    const message = db.insertMessage(fields)
    delivered(message.id)
    return message
  }
  const asked = send({
    from: 'orca_session_id:asking',
    to: 'orca_session_id:other',
    subject: 'Which branch?',
    type: 'question'
  })
  const again = send({
    from: 'orca_session_id:asking',
    to: 'orca_session_id:other',
    subject: 'And the tag?',
    type: 'handoff',
    threadId: asked.id
  })
  expect(sessionAwaitsMail(db, ['asking'])).toBe(true)
  // Mail sent on in the thread, or a reply naming nothing, answers neither.
  send({
    from: 'orca_session_id:other',
    to: 'orca_session_id:third',
    subject: 'Which branch?',
    type: 'question',
    threadId: asked.id
  })
  send({
    from: 'orca_session_id:other',
    to: 'orca_session_id:asking',
    subject: 'Hm',
    threadId: asked.id
  })
  expect(sessionAwaitsMail(db, ['asking'])).toBe(true)
  // One reply settles the ask it names, and only that one.
  send({
    from: 'orca_session_id:other',
    to: 'orca_session_id:asking',
    subject: 'Re: Which branch?',
    threadId: asked.id,
    replyTo: asked.id
  })
  expect(sessionAwaitsMail(db, ['asking'])).toBe(true)
  // A reply routed to the Run the asker coordinates still names its ask.
  send({
    from: 'orca_session_id:other',
    to: 'run:run_asking',
    subject: 'Re: And the tag?',
    threadId: asked.id,
    replyTo: again.id
  })
  expect(sessionAwaitsMail(db, ['asking'])).toBe(false)

  // A report waiting in the Run the chat coordinates.
  const coordinator = testOrcaSessionId('00000000-0000-4000-8000-0000000c0de0')
  const run = db.createRun({
    objective: 'run chat',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: coordinator
  }).id
  const report = db.insertMessage({
    from: 'worker',
    to: `run:${run}`,
    subject: 'Report',
    runId: run
  })
  expect(sessionAwaitsMail(db, [coordinator])).toBe(true)
  delivered(report.id)
  expect(sessionAwaitsMail(db, [coordinator])).toBe(false)

  // A worker that Run placed on a paired server, still being started or running there.
  const remoteTask = db.createTask({ runId: run, spec: 'Build on the server' })
  db.db
    .prepare(
      `INSERT INTO remote_placements (task_id, run_id, environment_id, conversation_id, state,
         request_key, prior_task_status) VALUES (?, ?, 'server', 'conversation', 'reserved', 'key', 'ready')`
    )
    .run(remoteTask.id, run)
  // Only while its link is open: under a closed link (a removed or re-made pairing) nothing answers.
  expect(sessionAwaitsMail(db, [coordinator])).toBe(false)
  db.db
    .prepare(
      `INSERT INTO remote_run_links (conversation_id, run_id, environment_id, peer_fingerprint,
         home_fingerprint) VALUES ('conversation', ?, 'server', 'fingerprint', 'home')`
    )
    .run(run)
  expect(sessionAwaitsMail(db, [coordinator])).toBe(true)
  db.db.prepare("UPDATE remote_run_links SET state = 'closed'").run()
  expect(sessionAwaitsMail(db, [coordinator])).toBe(false)

  // A worker the chat started on a paired server, or a helper that worker started there, holds it
  // while it runs there and its link is open; a settled one, or one settled here, does not.
  db.db
    .prepare(
      `INSERT INTO remote_run_links (conversation_id, run_id, environment_id, peer_fingerprint,
         home_fingerprint) VALUES ('helper_link', 'run_helper', 'server', 'fingerprint', 'home')`
    )
    .run()
  db.db
    .prepare(
      `INSERT INTO remote_dispatches (dispatch_id, conversation_id, run_id, environment_id, task_id,
         status, worker_state, creator_orca_session_id)
       VALUES ('ctx_helper', 'helper_link', 'run_helper', 'server', 'task_helper', 'dispatched',
         'running', 'helping')`
    )
    .run()
  const helperHolds = (set: string) => {
    db.db.prepare(`UPDATE remote_dispatches SET ${set} WHERE dispatch_id = 'ctx_helper'`).run()
    return sessionAwaitsMail(db, ['helping'])
  }
  expect(helperHolds("worker_state = 'running'")).toBe(true)
  expect(helperHolds("worker_state = NULL, status = 'pending'")).toBe(true)
  expect(helperHolds("status = 'failed'")).toBe(false)
  expect(helperHolds("worker_state = 'succeeded'")).toBe(false)
  expect(helperHolds("worker_state = 'running', task_settled_here = 2")).toBe(false)
  expect(helperHolds('task_settled_here = 0')).toBe(true)
  db.db.prepare("UPDATE remote_run_links SET state = 'closed'").run()
  expect(sessionAwaitsMail(db, ['helping'])).toBe(false)

  // A worker the chat started reports back to it.
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'Check the build' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: { agent: 'codex' }
  })
  db.db
    .prepare("UPDATE dispatch_contexts SET creator_orca_session_id = 'starter' WHERE id = ?")
    .run(dispatch.id)
  expect(sessionAwaitsMail(db, ['starter'])).toBe(true)
  db.failDispatch(dispatch.id, 'stopped', { workerProcessExited: true })
  expect(sessionAwaitsMail(db, ['starter'])).toBe(false)

  // Looked up by sender and recipient, never by scanning the mail.
  const plan = db.db
    .prepare(`EXPLAIN QUERY PLAN ${sessionAwaitsMailSql(2)}`)
    .all(...Array.from({ length: 8 }, () => ['x', 'y']).flat())
    .map((row) => String(row.detail))
  expect(plan.filter((detail) => detail.startsWith('SCAN'))).toEqual([])
})

it('a replayed reply naming only its thread settles one paired handoff, not the next', () => {
  const conversation = db.openHomePeerMailConversation({
    environmentId: 'server',
    peerFingerprint: 'fingerprint',
    localParty: 'orca_session_id:handing',
    localPaneKey: null
  })
  for (const [messageId, threadId] of [
    ['msg_first', undefined],
    ['msg_second', 'msg_first']
  ] as const) {
    recordPeerHandoffOut(db, {
      messageId,
      conversationId: conversation.conversation_id,
      environmentId: 'server',
      peerFingerprint: 'fingerprint',
      asker: 'orca_session_id:handing',
      threadId
    })
  }
  const reply = (messageId: string) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a conversation with no pane key reads nothing from the runtime.
    storePeerReply({} as never, db, conversation, messageId, {
      senderLabel: 'Server',
      fromAddress: 'term_remote',
      subject: 'Re: work',
      body: 'Done',
      threadId: 'msg_first'
    })
  // The replies themselves wait as mail for the chat; only the handoffs still out are counted here.
  const out = () =>
    db.db
      .prepare('SELECT message_id FROM peer_handoffs_out')
      .all()
      .map((row) => row.message_id)
  reply('peer_reply_1')
  reply('peer_reply_1')
  expect(out()).toEqual(['msg_second'])
  reply('peer_reply_2')
  expect(out()).toEqual([])
})
