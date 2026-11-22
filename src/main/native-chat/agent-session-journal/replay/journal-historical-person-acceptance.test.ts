import { afterEach, expect, it, vi } from 'vitest'
import { memoryJournalMap } from '../journal-memory-collections'
import Database from '../../../sqlite/sync-database'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { ensureJournalOutcomeTables } from '../outcomes/journal-outcome-format'
import '../outcomes/journal-outcome-codec'
import { createJournalReducerState } from '../projection/journal-reducer'
import { journalInputOrder } from '../input-order/journal-input-order'
import { nextEligibleQueuedCard } from '../queued-messages/journal-queue-mail-eligibility'
import { restoreHistoricalPersonAcceptance } from './journal-historical-inputs'
import { restoreRetainedJournalInputs } from './journal-retained-inputs'
import { agentSessionSendBodyFingerprint } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'

const databases: Database.Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function history() {
  const db = new Database(':memory:')
  databases.push(db)
  ensureJournalOutcomeTables(db)
  const insert = db.prepare(`INSERT INTO journal_outcomes
    (generation,seq,field,entry_key,format,ordinal,value_json,deleted) VALUES (1,?,?,?,3,'b',?,?)`)
  const save = (seq: number, field: string, key: string, value: unknown, deleted = false) =>
    insert.run(
      seq,
      field,
      JSON.stringify(key),
      JSON.stringify(deleted ? null : [key, value]),
      deleted ? 1 : 0
    )
  return { db, save }
}

function accepted(id: string, admission: number, queuedMessageId?: string): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 0,
    payloadFingerprint: id,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: admission,
    resolvedAt: admission + 1,
    submittedSequence: admission,
    acceptedSequence: admission,
    handoverRecorded: true,
    origin: 'client',
    ...(queuedMessageId ? { queuedMessageId } : { source: { kind: 'user' } })
  }
}

const waiting = (id: string, unattended = false) => ({
  messageId: id,
  position: 1,
  body: {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: id }]
  },
  fingerprint: id,
  state: 'waiting' as const,
  holdReason: null,
  returnedReason: null,
  returnedRejection: null,
  consumedAs: null,
  queuedAt: { epoch: 'epoch', sequence: 1 },
  unattended
})

function stopped() {
  const state = createJournalReducerState('session', 'epoch')
  state.queue.cards.set('W', waiting('W'))
  state.queuePauseMarks.latestStop = { sequence: 600, event: { reason: 'user-stop', at: 600 } }
  return state
}
const claim = (state: ReturnType<typeof stopped>) =>
  nextEligibleQueuedCard({
    state,
    floor: null,
    get: (id) => state.queue.cards.get(id) ?? null,
    editHeld: () => false,
    revisions: [],
    unavailable: undefined
  })

it('retired linked acceptance is bounded by original admission, not the first late outcome', () => {
  const { db, save } = history()
  save(2, 'queue.cards', 'P', waiting('P'))
  save(900, 'submissions', 'B', accepted('B', 800, 'P'))
  save(1000, 'submissions', 'A', accepted('A', 5))
  save(1001, 'submissions', 'B', null, true)
  save(1002, 'queue.cards', 'P', null, true)
  const state = stopped()
  restoreHistoricalPersonAcceptance(db, state, {
    generation: 1,
    through: 1002,
    format: 3,
    prefix: 0,
    marker: 6
  })
  expect(journalInputOrder(state).latestPersonAcceptedSequence()).toBe(800)
  expect(claim(state)?.messageId).toBe('W')
  expect([...memoryJournalMap(state.submissions).keys()]).toEqual([])
  expect([...memoryJournalMap(state.queue.cards).keys()]).toEqual(['W'])
})

it('late pre-Stop acceptance and explicit unattended handoffs cannot fabricate a personal lift', () => {
  const { db, save } = history()
  save(2, 'queue.cards', 'automation', waiting('automation', true))
  save(900, 'submissions', 'unattended', accepted('unattended', 800, 'automation'))
  save(1000, 'submissions', 'late', accepted('late', 10))
  const state = stopped()
  restoreHistoricalPersonAcceptance(db, state, {
    generation: 1,
    through: 1000,
    format: 3,
    prefix: 0,
    marker: 6
  })
  expect(claim(state)).toBeNull()
  expect(journalInputOrder(state).latestPersonAcceptedSequence()).toBe(10)
})

it('an old original admission survives new restatement and retirement, with canonical provenance first', () => {
  const { db, save } = history()
  const body = waiting('H').body
  const handoff = {
    ...accepted('H', 800, 'S'),
    payloadFingerprint: agentSessionSendBodyFingerprint('session', body)
  }
  const insert = db.prepare(`INSERT INTO journal_outcomes
    (generation,seq,field,entry_key,format,ordinal,value_json,deleted) VALUES (1,?,?,?,2,'s0000000000000800:0000000000000000',?,0)`)
  const original = (field: string, key: string, value: unknown) =>
    insert.run(800, field, JSON.stringify(key), JSON.stringify(value))
  original('submissions', 'H', ['H', { ...handoff, dispatchState: 'pending', resolvedAt: null }])
  original('items', 'orca:H', {
    itemId: 'orca:H',
    revision: 0,
    body,
    sequence: 800,
    observedAt: 800,
    turnScope: { kind: 'thread' }
  })
  original('itemFences', 'orca:H', ['orca:H', 0])
  insert.run(801, 'submissions', JSON.stringify('H'), JSON.stringify(['H', handoff]))
  save(900, 'submissions', 'H', handoff)
  save(901, 'submissions', 'H', null, true)
  const source = { generation: 1, through: 901, format: 3, prefix: 0, marker: 5 } as const
  for (const unattended of [false, true]) {
    const state = stopped()
    if (unattended) {
      state.queue.cards.set('S', waiting('S', true))
    }
    restoreRetainedJournalInputs(db, state, source)
    restoreHistoricalPersonAcceptance(db, state, source)
    expect(claim(state)?.messageId ?? null).toBe(unattended ? null : 'W')
    expect(state.submissions.size).toBe(0)
    expect(state.items.size).toBe(0)
  }
})
