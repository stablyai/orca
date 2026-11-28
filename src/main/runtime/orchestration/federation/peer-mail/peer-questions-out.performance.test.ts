import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  recordPeerQuestionOut,
  settlePeerQuestionsOut,
  tellUnpairedPeerQuestions
} from './peer-questions-out'

// #49521: an older Orca's reply, and each question at unpair, read one index seek, never every
// question this Orca ever asked.
describe('paired-question lookups by thread', () => {
  let db: OrchestrationDb
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only the stubbed members.
  const runtime = {
    getLiveTerminalPaneKey: () => null,
    getTerminalHandleForPaneKey: () => null,
    notifyMessageArrived: () => {},
    notifyPeerMailReturned: () => {}
  } as unknown as OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  it('never scans the asked questions for a reply that names none, or at unpair', () => {
    const conversationId = db.openHomePeerMailConversation({
      environmentId: 'env_box',
      peerFingerprint: 'fp-1',
      localParty: 'term_asker',
      localPaneKey: null
    }).conversation_id
    for (const id of ['msg_q1', 'msg_q2']) {
      recordPeerQuestionOut(db, {
        messageId: id,
        conversationId,
        environmentId: 'env_box',
        peerFingerprint: 'fp-1',
        asker: 'term_asker',
        threadId: 'thread_1'
      })
    }
    const prepare = db.db.prepare.bind(db.db)
    const statements = new Set<string>()
    db.db.prepare = (sql: string) => (statements.add(sql), prepare(sql))
    settlePeerQuestionsOut(db, conversationId, { threadId: 'thread_1' })
    tellUnpairedPeerQuestions(runtime, db, {
      environmentId: 'env_box',
      serverName: 'Build Box',
      reason: 'Build Box was removed.'
    })
    db.db.prepare = prepare

    const reads = [...statements]
      .filter((sql) => /FROM peer_questions_out\s+WHERE conversation_id/.test(sql))
      .map((sql) =>
        prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all()
          .map((step) => String(step.detail))
          .filter((step) => step.includes('peer_questions_out') && !step.includes('rowid=?'))
      )
    expect(reads).toHaveLength(2)
    for (const plan of reads) {
      expect(plan).toHaveLength(1)
      expect(plan[0]).toBe(
        'SEARCH peer_questions_out USING COVERING INDEX idx_peer_questions_out_thread (conversation_id=? AND <expr>=? AND awaiting=?)'
      )
    }
  })
})
