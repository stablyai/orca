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

  const issue = (messageId: string) =>
    db.enqueueFederationRelay({
      dispatchId: conversationId,
      direction: 'to_worker',
      kind: 'client_ask',
      messageId,
      payload: '{}'
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

  it("shows this Orca's own notice for a question settled without an answer", () => {
    issue('msg_question')
    recordPeerQuestionOut(db, {
      messageId: 'msg_question',
      conversationId,
      environmentId: 'client:device_a/install_a',
      peerFingerprint: 'fp_a',
      asker: ASKER
    })
    db.db.prepare('UPDATE peer_questions_out SET awaiting = NULL').run()
    const notice = db.insertMessage({
      from: 'Client A',
      to: ASKER,
      subject: 'Re: Question',
      body: 'The pairing with Client A was re-made.',
      threadId: 'msg_question'
    })

    expect(readClientAskOutcome(db, 'msg_question')).toEqual({
      outcome: 'dropped',
      answer: 'The pairing with Client A was re-made.',
      mailIds: [notice.id],
      chatId: null
    })
  })
})
