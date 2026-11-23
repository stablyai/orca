import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  recordPeerQuestionOut,
  settlePeerQuestionsOut,
  tellUnpairedPeerQuestions
} from './peer-questions-out'

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
