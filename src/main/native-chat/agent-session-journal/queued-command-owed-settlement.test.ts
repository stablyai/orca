import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import Database from '../../sqlite/sync-database'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { ensureQueuedMessagesTable } from './queued-message-schema'
import { queuedMessageSettlementOwed, settleOwedQueuedMessages } from './queued-message-settlement'
import {
  consumeQueuedMessageInTransaction,
  getQueuedMessage,
  insertQueuedMessage
} from './queued-message-table'

const SESSION = 'owed-command'
const SUBMISSION = 'submission'
let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  ensureQueuedMessagesTable(db)
})

afterEach(() => db.close())

function refusedCard(command: boolean) {
  insertQueuedMessage(db, {
    sessionId: SESSION,
    messageId: 'card',
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: command ? '/compact' : 'plain message' }],
      ...(command ? { command: { name: 'compact' } } : {})
    },
    fingerprint: 'fp',
    hostInstance: 'host',
    queuedAt: { epoch: 'epoch', sequence: 1 },
    now: 1
  })
  db.exec('BEGIN IMMEDIATE')
  expect(
    consumeQueuedMessageInTransaction(db, {
      sessionId: SESSION,
      messageId: 'card',
      expect: 'waiting',
      consumedAs: SUBMISSION,
      settledByOp: null,
      now: 2
    })
  ).toBe(true)
  db.exec('COMMIT')
  const state = createJournalReducerState(SESSION, 'epoch')
  state.submissions.set(SUBMISSION, {
    clientMessageId: SUBMISSION,
    queuedMessageId: 'card',
    dispatchState: 'rejected',
    fence: 0,
    payloadFingerprint: 'fp',
    providerItemId: null,
    reason: null,
    rejection: agentSessionFailureFact('providerRejected'),
    submittedAt: 1,
    resolvedAt: 2
  })
  expect(queuedMessageSettlementOwed(db, SESSION, state.submissions)).toBe(true)
  return state
}

function reportCommandTurn(state: JournalReducerState) {
  const itemId = agentJournalItemKey(structuredAgentSessionCommandTurnIdentity(SUBMISSION))
  state.items.set(itemId, {
    itemId,
    revision: 0,
    sequence: 2,
    observedAt: 2,
    body: {
      kind: 'turn',
      turnId: `compact:${SUBMISSION}`,
      state: 'completed',
      outcome: 'failure',
      completedAt: 2
    }
  })
}

describe('owed settlement of refused command cards', () => {
  it('withdraws a refused command card whose command turn already reports the refusal', () => {
    const state = refusedCard(true)
    reportCommandTurn(state)
    expect(settleOwedQueuedMessages(db, { sessionId: SESSION, state, now: 10 })).toBe(1)
    expect(getQueuedMessage(db, SESSION, 'card')?.state).toBe('withdrawn')
    expect(queuedMessageSettlementOwed(db, SESSION, state.submissions)).toBe(false)
  })

  it('returns a refused command card when its command turn is absent', () => {
    const state = refusedCard(true)
    expect(settleOwedQueuedMessages(db, { sessionId: SESSION, state, now: 10 })).toBe(1)
    expect(getQueuedMessage(db, SESSION, 'card')?.state).toBe('returned')
    expect(queuedMessageSettlementOwed(db, SESSION, state.submissions)).toBe(false)
  })

  it('returns a plain message even when its submission has a command-turn key', () => {
    const state = refusedCard(false)
    reportCommandTurn(state)
    expect(settleOwedQueuedMessages(db, { sessionId: SESSION, state, now: 10 })).toBe(1)
    expect(getQueuedMessage(db, SESSION, 'card')?.state).toBe('returned')
    expect(queuedMessageSettlementOwed(db, SESSION, state.submissions)).toBe(false)
  })
})
