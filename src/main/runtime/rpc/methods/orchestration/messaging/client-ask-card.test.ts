import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { recordPeerQuestionOut } from '../../../../orchestration/federation/peer-mail/peer-questions-out'
import { readClientAskOutcome } from './client-ask-card'

const ASKER = 'term_s'
const NOTHING = { outcome: null, answer: null, mailIds: [], chatId: null }

describe("the card of an ask to a paired computer's agent", () => {
  let dir: string
  let db: OrchestrationDb
  let conversationId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-client-ask-card-'))
    db = new OrchestrationDb(join(dir, 'server.db'))
    conversationId = db.openHomePeerMailConversation({
      environmentId: 'client:device_a/install_a',
      peerFingerprint: 'fp_a',
      localParty: ASKER,
      localPaneKey: null
    }).conversation_id
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const issue = (
    messageId: string,
    ask: { type: string; threadId?: string } = { type: 'handoff' }
  ) =>
    db.enqueueFederationRelay({
      dispatchId: conversationId,
      direction: 'to_worker',
      kind: 'client_ask',
      messageId,
      payload: JSON.stringify(ask)
    })

  const returned = (conversation: string, id: string, threadId: string, body: string) =>
    db.insertPeerMailMessage({
      conversationId: conversation,
      remoteParty: 'bot:Literature',
      message: { id, from: 'Literature', to: ASKER, subject: 'Re: Ask', body, threadId }
    })

  it('reads nothing for a thread no ask of this Orca opened', () => {
    const local = db.insertMessage({ from: 'term_x', to: ASKER, subject: 'Private', body: 'A' })
    db.insertMessage({ from: 'term_x', to: ASKER, subject: 'Re', body: 'B', threadId: local.id })

    expect(readClientAskOutcome(db, local.id)).toEqual(NOTHING)
  })

  it("answers a handoff only from its own conversation's reply", () => {
    issue('msg_handoff')
    db.db
      .prepare(
        `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint, environment_id)
         VALUES ('peerconv_0000000000f1', 'peer', 'fp_other', 'env_other')`
      )
      .run()
    returned('peerconv_0000000000f1', 'msg_elsewhere', 'msg_handoff', 'From another conversation.')
    expect(readClientAskOutcome(db, 'msg_handoff')).toEqual(NOTHING)

    returned(conversationId, 'msg_taken', 'msg_handoff', 'Taken.')
    expect(readClientAskOutcome(db, 'msg_handoff')).toEqual({
      outcome: 'answered',
      answer: 'Taken.',
      mailIds: ['msg_taken'],
      chatId: null
    })
  })

  it('keeps reading an answered ask after its tasks are reset, since its mail survives', () => {
    issue('msg_kept')
    returned(conversationId, 'msg_kept_answer', 'msg_kept', 'Kept.')

    db.resetTasks()

    expect(readClientAskOutcome(db, 'msg_kept')).toMatchObject({
      outcome: 'answered',
      answer: 'Kept.'
    })
  })

  it("shows this Orca's own notice for a question settled without an answer, never other local mail", () => {
    issue('msg_question', { type: 'question' })
    recordPeerQuestionOut(db, {
      messageId: 'msg_question',
      conversationId,
      environmentId: 'client:device_a/install_a',
      peerFingerprint: 'fp_a',
      asker: ASKER
    })
    db.db.prepare('UPDATE peer_questions_out SET awaiting = NULL').run()
    const body =
      'The pairing with Client A was re-made. Your question msg_question there will not be answered.'
    const notice = db.insertMessage({
      from: 'Client A',
      to: ASKER,
      subject: 'Re: Question',
      body,
      threadId: 'msg_question'
    })
    db.insertMessage({
      from: 'term_x',
      to: ASKER,
      subject: 'Re',
      body: 'Other',
      threadId: 'msg_question'
    })

    expect(readClientAskOutcome(db, 'msg_question')).toEqual({
      outcome: 'dropped',
      answer: body,
      mailIds: [notice.id],
      chatId: null
    })
  })

  it('reads a question sent in a shared thread by what names it, and no status ask at all', () => {
    issue('msg_in_thread', { type: 'question', threadId: 'thread_shared' })
    issue('msg_status', { type: 'status' })
    returned(conversationId, 'msg_other_reply', 'thread_shared', 'About something else.')
    db.insertPeerMailMessage({
      conversationId,
      remoteParty: 'bot:Literature',
      message: {
        id: 'msg_its_answer',
        from: 'Literature',
        to: ASKER,
        subject: 'Re: Ask',
        body: 'All real.',
        threadId: 'thread_shared',
        payload: JSON.stringify({ requestId: 'msg_in_thread', botAnswer: true })
      }
    })
    recordPeerQuestionOut(db, {
      messageId: 'msg_in_thread',
      conversationId,
      environmentId: 'client:device_a/install_a',
      peerFingerprint: 'fp_a',
      asker: ASKER,
      threadId: 'thread_shared'
    })

    expect(readClientAskOutcome(db, 'msg_in_thread')).toEqual({
      outcome: 'answered',
      answer: 'All real.',
      mailIds: ['msg_its_answer'],
      chatId: null
    })
    expect(readClientAskOutcome(db, 'msg_status')).toEqual(NOTHING)
  })

  it("keeps a handoff's earlier reply once a later ask shares its thread, and takes none after", () => {
    const at = (
      table: 'messages' | 'federation_relay_items',
      idColumn: string,
      id: string,
      time: string
    ) => db.db.prepare(`UPDATE ${table} SET created_at = ? WHERE ${idColumn} = ?`).run(time, id)
    issue('msg_handoff')
    returned(conversationId, 'msg_handoff_reply', 'msg_handoff', 'On it.')
    at('messages', 'id', 'msg_handoff_reply', '2026-11-01 10:00:00')
    // The unambiguous case: alone in its thread, its first reply is its own.
    expect(readClientAskOutcome(db, 'msg_handoff')).toMatchObject({
      outcome: 'answered',
      answer: 'On it.'
    })

    // A later question and handoff sent into the handoff's thread, after its reply came back.
    issue('msg_later_question', { type: 'question', threadId: 'msg_handoff' })
    issue('msg_later_handoff', { type: 'handoff', threadId: 'msg_handoff' })
    at('federation_relay_items', 'message_id', 'msg_later_question', '2026-11-01 10:00:05')
    at('federation_relay_items', 'message_id', 'msg_later_handoff', '2026-11-01 10:00:09')
    db.insertPeerMailMessage({
      conversationId,
      remoteParty: 'bot:Literature',
      message: {
        id: 'msg_later_answer',
        from: 'Literature',
        to: ASKER,
        subject: 'Re: Ask',
        body: 'The later answer.',
        threadId: 'msg_handoff',
        payload: JSON.stringify({ requestId: 'msg_later_question', botAnswer: true })
      }
    })
    returned(conversationId, 'msg_later_question_declined', 'msg_handoff', 'Declined.')
    // Plain replies of the same second as the later ask, or after it, could answer either.
    returned(conversationId, 'msg_same_second', 'msg_handoff', 'Same second.')
    at('messages', 'id', 'msg_same_second', '2026-11-01 10:00:05')
    returned(conversationId, 'msg_after', 'msg_handoff', 'After.')
    at('messages', 'id', 'msg_after', '2026-11-01 10:00:20')

    expect(readClientAskOutcome(db, 'msg_handoff')).toEqual({
      outcome: 'answered',
      answer: 'On it.',
      mailIds: ['msg_handoff_reply'],
      chatId: null
    })
    // Had that reply come back only after the later ask, nothing would be taken for the handoff.
    at('messages', 'id', 'msg_handoff_reply', '2026-11-01 10:00:30')
    expect(readClientAskOutcome(db, 'msg_handoff')).toEqual(NOTHING)
  })
})
