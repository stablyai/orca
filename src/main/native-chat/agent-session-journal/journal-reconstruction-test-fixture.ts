import { expect } from 'vitest'
import { join } from 'node:path'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order-owner'
import {
  openTestJournalHostDatabase,
  insertTestJournalRow,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import {
  projectionBase,
  projectionEpoch,
  projectionEpochRow,
  projectionSessionId
} from './journal-projection-test-support'
import { restoreJournal } from './journal-open'
import { restoreJournalAsync } from './journal-async-open'
import { encodeJournalState } from './journal-state-codec'
import type { JournalRow } from './journal-row-schema'

const body: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'legacy card' }]
}

export async function seedLinkedLegacyReconstruction(root: string, size: number) {
  const database = await openTestJournalHostDatabase(join(root, `linked-${size}`))
  database.fixtureTransaction((db) => {
    publishTestJournalEpoch(db, projectionSessionId, projectionEpoch)
    insertTestJournalRow(db, projectionSessionId, projectionEpochRow)
    let sequence = 1
    for (let index = 0; index < size; index++) {
      const id = `linked-${index}`
      insertTestJournalRow(db, projectionSessionId, {
        ...projectionBase(++sequence),
        kind: 'submission',
        clientMessageId: id,
        body,
        payloadFingerprint: 'legacy-body',
        providerHandle: { kind: 'codex', threadId: 'thread-1' },
        queuedMessageId: 'legacy',
        handoverRecorded: true,
        origin: 'host'
      })
      insertTestJournalRow(db, projectionSessionId, {
        ...projectionBase(++sequence),
        kind: 'dispatch',
        clientMessageId: id,
        state: 'rejected',
        reason: 'hostRestarted',
        providerItemId: null
      })
    }
    db.prepare(`INSERT INTO queued_messages (session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      projectionSessionId,
      'legacy',
      1,
      JSON.stringify(body),
      'legacy-body',
      1,
      'old-host',
      'waiting'
    )
  })
  return database
}

export async function verifyInputOnlyCleanup(root: string): Promise<void> {
  const database = await openTestJournalHostDatabase(join(root, 'settled-input'))
  const rows: JournalRow[] = [
    {
      ...projectionBase(1),
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: 'thread-1' },
      inputOrderLineage: {
        clock: 1,
        cards: [
          {
            messageId: 'old-card',
            introduced: 1,
            baseline: { coordinate: { epoch: 'old-epoch', sequence: 1 } }
          }
        ]
      }
    }
  ]
  for (const [id, basis, settled] of [
    ['observed', 'observed', 'accepted'],
    ['legacy', 'legacy', 'rejected'],
    ['retired', 'legacy', 'retired'],
    ['pending', 'observed', 'pending']
  ] as const) {
    const seq = rows.length + 1
    rows.push({
      ...projectionBase(seq),
      kind: 'submission',
      clientMessageId: id,
      body,
      payloadFingerprint: id,
      providerHandle: { kind: 'codex', threadId: 'thread-1' },
      handoverRecorded: true,
      origin: 'client',
      inputOrderContext: {
        source: { epoch: projectionEpoch, sequence: seq },
        basis,
        cut: seq
      }
    })
    if (settled === 'retired') {
      rows.push({
        ...projectionBase(rows.length + 1),
        kind: 'tombstone',
        itemId: agentJournalSubmissionKey(id),
        revision: 1,
        retireSubmission: true
      })
    } else if (settled !== 'pending') {
      rows.push({
        ...projectionBase(rows.length + 1),
        kind: 'dispatch',
        clientMessageId: id,
        state: settled,
        providerItemId: null,
        reason: settled === 'rejected' ? 'hostRestarted' : null
      })
    }
  }
  const live = createJournalReducerState(projectionSessionId, projectionEpoch)
  database.fixtureTransaction((db) => {
    publishTestJournalEpoch(db, projectionSessionId, projectionEpoch)
    for (const row of rows) {
      insertTestJournalRow(db, projectionSessionId, row)
      applyJournalRow(live, row)
    }
  })
  expect([...live.inputEntries.keys()]).toEqual(['pending'])
  expect(live.inputCards.size).toBe(0)
  const sync = restoreJournal(database.db, projectionSessionId)
  const async = await database.read((read) => restoreJournalAsync(read, projectionSessionId))
  for (const restored of [sync, async]) {
    expect(restored?.damage).toBeNull()
    expect(restored?.newer).toBeNull()
    expect(restored && encodeJournalState(restored.state)).toEqual(encodeJournalState(live))
    expect(
      restored &&
        [...journalInputOrder(restored.state).lineage.cards.values()].every(
          (card) => !card.baseline
        )
    ).toBe(true)
  }
}
