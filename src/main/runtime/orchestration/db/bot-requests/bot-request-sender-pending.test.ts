import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { recordPeerQuestionOut } from '../../federation/peer-mail/peer-questions-out'
import { OrchestrationDb } from '../orchestration-db'
import { sessionAwaitsBotReply } from './bot-request-sender-pending'

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

it('a chat owes a reply from its open requests and paired asks, until each ends', () => {
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

  expect(sessionAwaitsBotReply(db, ['status-only'])).toBe(false)
  // A /clear moved the chat on: its first id and the live one both count.
  expect(sessionAwaitsBotReply(db, ['root', 'live'])).toBe(true)
  db.recordBotRequestOutcome(question, 'answered')
  expect(sessionAwaitsBotReply(db, ['root'])).toBe(false)
  expect(sessionAwaitsBotReply(db, ['root', 'live'])).toBe(true)
  expect(sessionAwaitsBotReply(db, ['paired'])).toBe(true)

  db.close()
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  expect(sessionAwaitsBotReply(db, ['live'])).toBe(true)
  expect(sessionAwaitsBotReply(db, ['paired'])).toBe(true)
  db.recordBotRequestOutcome(handoff, 'unanswered')
  db.db.prepare('UPDATE peer_questions_out SET awaiting = NULL').run()
  expect(sessionAwaitsBotReply(db, ['live', 'paired'])).toBe(false)

  // Looked up by sender, never by scanning the mail.
  const plan = db.db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT 1 FROM messages m WHERE m.from_handle IN (?) AND m.type IN ('question', 'handoff')
       UNION ALL SELECT 1 FROM peer_questions_out WHERE awaiting = 1 AND asker IN (?)`
    )
    .all('x', 'x')
    .map((row) => String(row.detail))
  expect(plan.filter((detail) => detail.startsWith('SCAN'))).toEqual([])
})
