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

  // A question to an ordinary chat is owed until a reply lands in its thread.
  const asked = db.insertMessage({
    from: 'orca_session_id:asking',
    to: 'orca_session_id:other',
    subject: 'Which branch?',
    type: 'question'
  })
  db.db.prepare("UPDATE messages SET delivered_at = datetime('now') WHERE id = ?").run(asked.id)
  expect(sessionAwaitsMail(db, ['asking'])).toBe(true)
  // Mail it sends on in the thread to someone else is no answer.
  const forwarded = db.insertMessage({
    from: 'orca_session_id:other',
    to: 'orca_session_id:third',
    subject: 'Which branch?',
    type: 'question',
    threadId: asked.id
  })
  db.db.prepare("UPDATE messages SET delivered_at = datetime('now') WHERE id = ?").run(forwarded.id)
  expect(sessionAwaitsMail(db, ['asking'])).toBe(true)
  const reply = db.insertMessage({
    from: 'orca_session_id:other',
    to: 'orca_session_id:asking',
    subject: 'Re: Which branch?',
    threadId: asked.id
  })
  db.db.prepare("UPDATE messages SET delivered_at = datetime('now') WHERE id = ?").run(reply.id)
  expect(sessionAwaitsMail(db, ['asking'])).toBe(false)

  // A handoff to one chat and a question to another in the same thread: each is owed by its own
  // recipient, so one reply settles only its own.
  const delivered = (id: string) =>
    db.db.prepare("UPDATE messages SET delivered_at = datetime('now') WHERE id = ?").run(id)
  for (const [to, type] of [
    ['orca_session_id:a', 'handoff'],
    ['orca_session_id:b', 'question']
  ] as const) {
    delivered(
      db.insertMessage({ from: 'orca_session_id:two', to, subject: 'Job', type, threadId: 'job' })
        .id
    )
  }
  delivered(
    db.insertMessage({
      from: 'orca_session_id:a',
      to: 'orca_session_id:two',
      subject: 'Done',
      threadId: 'job'
    }).id
  )
  expect(sessionAwaitsMail(db, ['two'])).toBe(true)
  delivered(
    db.insertMessage({
      from: 'orca_session_id:b',
      to: 'orca_session_id:two',
      subject: 'Yes',
      threadId: 'job'
    }).id
  )
  expect(sessionAwaitsMail(db, ['two'])).toBe(false)

  // A follow-up in the same thread, sent the same second the first answer came: that earlier answer
  // doesn't settle it.
  delivered(
    db.insertMessage({
      from: 'orca_session_id:two',
      to: 'orca_session_id:b',
      subject: 'And?',
      type: 'question',
      threadId: 'job'
    }).id
  )
  db.db
    .prepare("UPDATE messages SET created_at = '2026-01-01 00:00:00' WHERE thread_id = 'job'")
    .run()
  expect(sessionAwaitsMail(db, ['two'])).toBe(true)

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
  expect(sessionAwaitsMail(db, [coordinator])).toBe(true)
  db.db.prepare('DELETE FROM remote_placements WHERE task_id = ?').run(remoteTask.id)
  expect(sessionAwaitsMail(db, [coordinator])).toBe(false)

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
