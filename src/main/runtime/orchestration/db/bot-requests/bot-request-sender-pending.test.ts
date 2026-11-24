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
import { OrchestrationDb } from '../orchestration-db'
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
  const handOff = (messageId: string) =>
    recordPeerHandoffOut(db, {
      messageId,
      conversationId: 'conversation',
      environmentId: 'server',
      peerFingerprint: 'fingerprint',
      asker: 'orca_session_id:handing'
    })
  handOff('msg_handoff')
  expect(sessionAwaitsMail(db, ['handing'])).toBe(true)
  // An older paired Orca's reply names only its thread.
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
  const reply = db.insertMessage({
    from: 'orca_session_id:other',
    to: 'orca_session_id:asking',
    subject: 'Re: Which branch?',
    threadId: asked.id
  })
  db.db.prepare("UPDATE messages SET delivered_at = datetime('now') WHERE id = ?").run(reply.id)
  expect(sessionAwaitsMail(db, ['asking'])).toBe(false)

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
    .all('x', 'y', 'x', 'y', 'x', 'y', 'x', 'y', 'x', 'y')
    .map((row) => String(row.detail))
  expect(plan.filter((detail) => detail.startsWith('SCAN'))).toEqual([])
})
