import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  recordPeerQuestionOut,
  settlePeerQuestionsOut,
  tellUnpairedPeerQuestions
} from './peer-questions-out'
import { storePeerReply } from './peer-reply-store'

const REMOVED = "Build Box was removed from this Orca's paired servers."

describe('questions asked of an agent on a paired computer', () => {
  let db: OrchestrationDb
  let notified: string[]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only the stubbed members.
  const runtime = {
    getLiveTerminalPaneKey: () => null,
    getTerminalHandleForPaneKey: () => null,
    notifyMessageArrived: (handle: string) => void notified.push(handle),
    notifyPeerMailReturned: () => {}
  } as unknown as OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    notified = []
  })
  afterEach(() => db.close())

  function asked(id: string, pairing = 'fp-1', threadId?: string): void {
    const conversation = db.openHomePeerMailConversation({
      environmentId: 'env_box',
      peerFingerprint: pairing,
      localParty: 'term_asker',
      localPaneKey: null
    })
    recordPeerQuestionOut(db, {
      messageId: id,
      conversationId: conversation.conversation_id,
      environmentId: 'env_box',
      peerFingerprint: pairing,
      asker: 'term_asker',
      threadId
    })
  }

  function unpair(): void {
    tellUnpairedPeerQuestions(runtime, db, {
      environmentId: 'env_box',
      serverName: 'Build Box',
      reason: REMOVED
    })
  }

  const told = () => db.getAllMessagesForHandle('term_asker').map((m) => [m.thread_id, m.body])

  it('tells the asker once when that computer is removed', () => {
    asked('msg_q')
    unpair()
    unpair()

    expect(told()).toEqual([
      [
        'msg_q',
        `${REMOVED} Your question msg_q there will not be answered. Decide without it, or ask again.`
      ]
    ])
    expect(notified).toEqual(['term_asker'])
  })

  it('tells nothing for a question whose answer or notice came back', () => {
    asked('msg_answered')
    asked('msg_old_peer', 'fp-1', 'thread_1')
    const conversation = db.openHomePeerMailConversation({
      environmentId: 'env_box',
      peerFingerprint: 'fp-1',
      localParty: 'term_asker',
      localPaneKey: null
    }).conversation_id
    settlePeerQuestionsOut(db, conversation, {
      notice: { requestId: 'msg_answered' },
      threadId: null
    })
    // An older paired Orca names no request: its reply settles the question's thread.
    settlePeerQuestionsOut(db, conversation, { threadId: 'thread_1' })
    unpair()

    expect(told()).toEqual([])
  })

  const conversationId = () =>
    db.openHomePeerMailConversation({
      environmentId: 'env_box',
      peerFingerprint: 'fp-1',
      localParty: 'term_asker',
      localPaneKey: null
    }).conversation_id
  const open = () =>
    db.db
      .prepare('SELECT message_id FROM peer_questions_out WHERE awaiting = 1 ORDER BY rowid')
      .all()
      .map((row) => row.message_id)

  it('settles no question for a reply to a handoff in its thread', () => {
    asked('msg_q', 'fp-1', 'thread_1')
    settlePeerQuestionsOut(db, conversationId(), { replyTo: 'msg_handoff', threadId: 'thread_1' })

    expect(open()).toEqual(['msg_q'])
  })

  it("settles the oldest open question of its thread for an older Orca's reply, once per reply", () => {
    asked('msg_q1', 'fp-1', 'thread_1')
    asked('msg_q2', 'fp-1', 'thread_1')
    asked('msg_q3', 'fp-1', 'thread_1')
    const reply = {
      senderLabel: 'term_b on Build Box',
      fromAddress: 'term_b',
      subject: 'Re: Question',
      body: 'Yes.',
      threadId: 'thread_1'
    }
    const conversation = db.getPeerMailConversation(conversationId())!
    storePeerReply(runtime, db, conversation, 'msg_r1', reply)
    // Pulled again after a crash before its acknowledgment.
    storePeerReply(runtime, db, conversation, 'msg_r1', reply)
    expect(open()).toEqual(['msg_q2', 'msg_q3'])

    storePeerReply(runtime, db, conversation, 'msg_r2', reply)
    expect(open()).toEqual(['msg_q3'])
  })

  it("never says a question won't be answered after an older Orca's reply in its thread", () => {
    asked('msg_q1', 'fp-1', 'thread_1')
    asked('msg_q2', 'fp-1', 'thread_1')
    asked('msg_other', 'fp-1', 'thread_2')
    const conversation = db.getPeerMailConversation(conversationId())!
    storePeerReply(runtime, db, conversation, 'msg_r1', {
      senderLabel: 'term_b on Build Box',
      fromAddress: 'term_b',
      subject: 'Re: Question',
      body: 'Both: yes.',
      threadId: 'thread_1'
    })
    unpair()

    expect(
      told()
        .filter(([, body]) => body?.startsWith(REMOVED))
        .sort()
    ).toEqual([
      [
        'thread_1',
        `${REMOVED} Your question msg_q2 there may already be answered. Check the replies in this thread, or ask again.`
      ],
      [
        'thread_2',
        `${REMOVED} Your question msg_other there will not be answered. Decide without it, or ask again.`
      ]
    ])
  })

  it('on a re-pair, tells only the questions sent under the older pairing', () => {
    asked('msg_before', 'fp-1')
    asked('msg_after', 'fp-2')
    tellUnpairedPeerQuestions(runtime, db, {
      environmentId: 'env_box',
      server: {
        environmentId: 'env_box',
        name: 'Build Box',
        peerFingerprint: 'host',
        homePeerFingerprint: 'fp-2',
        pairingRevision: 2
      }
    })

    expect(told().map(([thread]) => thread)).toEqual(['msg_before'])
  })
})
