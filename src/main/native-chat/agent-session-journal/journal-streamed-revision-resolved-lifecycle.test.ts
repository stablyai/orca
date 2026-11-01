import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { JournalGoalAttachmentInverse } from './journal-goal-attachment-inverse'
import type { JournalOperationReceipt } from './journal-row-writer'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from './journal-row-schema'
import * as attachmentReferences from '../agent-session-attachments/agent-session-attachment-references'

import {
  fixture,
  commitLevels,
  openJournal,
  text,
  uploadedInput
} from './journal-streamed-revision-contract-test-fixture'

it('resolves/builds once after preceding writes and preserves actual output and external receipt durability', async () => {
  const journal = await openJournal()
  const identity = { provider: 'orca' as const, clientMessageId: 'dynamic' }
  let release = () => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = journal.readInOrder(() => barrier)
  const levels = commitLevels()
  const preceding = journal.appendItem(identity, text('assistant', 'first'), {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  const resolve = vi.fn(() => {
    expect(journal.snapshot().items[0]?.body).toEqual(text('assistant', 'first'))
    return { identity, body: text('assistant', 'second') }
  })
  const following = journal.appendResolvedItem(resolve, {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  release()
  await Promise.all([held, preceding, following])
  expect(resolve).toHaveBeenCalledTimes(1)
  expect(levels).toEqual([2, 1])
  levels.length = 0
  const empty = vi.fn(() => null)
  expect(
    await journal.appendResolvedItem(empty, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  ).toBeNull()
  expect(empty).toHaveBeenCalledTimes(1)
  expect(levels).toEqual([])

  const { db } = openTestJournalHostDatabase(fixture.root)
  db.exec('CREATE TABLE receipt_fact (sequence INTEGER)')
  const write = vi.fn<JournalOperationReceipt['write']>((connection, row) => {
    if (!row) {
      throw new Error('missing receipt target')
    }
    connection.prepare('INSERT INTO receipt_fact VALUES (?)').run(row.seq)
  })
  const committed = vi.fn(() =>
    expect(db.prepare('SELECT sequence FROM receipt_fact').all()).toHaveLength(1)
  )
  const result = await journal.appendItem(
    identity,
    text('assistant', 'durable receipt'),
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE },
    { write, committed }
  )
  expect(levels).toEqual([2])
  expect(db.prepare('SELECT sequence FROM receipt_fact').get()?.sequence).toBe(
    result.cursor.sequence
  )
  expect(write).toHaveBeenCalledTimes(1)
  expect(committed).toHaveBeenCalledTimes(1)
  const huge = 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES)
  for (const mode of ['ordinary', 'planned', 'step'] as const) {
    const body = text('assistant', `${huge}${mode}`)
    const plan = vi.fn(() => [
      { kind: 'item' as const, identity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    ])
    levels.length = 0
    if (mode === 'ordinary') {
      await journal.appendLifecycleBatch({ settlementId: mode, fence: 1, mutations: plan() })
    }
    if (mode === 'planned') {
      await journal.appendPlannedLifecycleBatch({
        settlementId: mode,
        fence: 1,
        plan: () => ({ mutations: plan(), dispatches: [] })
      })
    }
    if (mode === 'step') {
      await journal.appendSteps([
        { kind: 'settlement', batch: { settlementId: mode, fence: 1, resolve: plan } }
      ])
    }
    expect(plan).toHaveBeenCalledTimes(1)
    expect(levels).toEqual([1])
    expect(journal.snapshot().items[0]?.body).toEqual(body)
  }
  levels.length = 0
  expect(
    await journal.appendSteps([
      {
        kind: 'item',
        resolve: () => null,
        options: { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      }
    ])
  ).toEqual([false])
  await journal.appendPlannedLifecycleBatch({
    settlementId: 'empty',
    fence: 1,
    plan: () => ({ mutations: [], dispatches: [] })
  })
  expect(levels).toEqual([])
  await journal.appendLifecycleBatch({
    settlementId: 'envelope',
    fence: 1,
    mutations: [
      {
        kind: 'item',
        identity,
        body: text('assistant', 'settled'),
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ]
  })
  expect(levels).toEqual([2])
})

it.each([1, 10])(
  'protects %i actual independent inputs per writer without visiting prior history',
  async (count) => {
    const journal = await openJournal()
    const other = await openJournal('other')
    for (let n = 0; n < 10 * count; n++) {
      const identity = { provider: 'orca' as const, clientMessageId: `old-${n}` }
      await journal.appendItem(identity, text('user', 'old'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await other.appendItem(identity, text('user', 'unrelated'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    }
    const { db } = openTestJournalHostDatabase(fixture.root)
    const insertion = vi.spyOn(
      db.prepare(
        'INSERT OR IGNORE INTO agent_session_attachment_claims (upload_id, session_id, claimed_at) VALUES (?, ?, ?)'
      ),
      'run'
    )
    const extraction = vi.spyOn(attachmentReferences, 'agentSessionAttachmentReferences')
    const acquired = vi.spyOn(JournalGoalAttachmentInverse.prototype, 'acquired')
    const levels = commitLevels()
    for (const writer of [
      'direct',
      'resolved',
      'step',
      'batch',
      'planned',
      'submission',
      'queue'
    ] as const) {
      insertion.mockClear()
      extraction.mockClear()
      acquired.mockClear()
      levels.length = 0
      for (let n = 0; n < count; n++) {
        const { id, body } = await uploadedInput()
        const identity = { provider: 'orca' as const, clientMessageId: `${writer}-${n}` }
        const resolve = vi.fn(() => ({ identity, body }))
        if (writer === 'direct') {
          await journal.appendItem(identity, body, {
            fence: 1,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          })
        }
        if (writer === 'resolved') {
          await journal.appendResolvedItem(resolve, {
            fence: 1,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          })
          expect(resolve).toHaveBeenCalledTimes(1)
        }
        if (writer === 'step') {
          await journal.appendSteps([
            { kind: 'item', resolve, options: { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE } }
          ])
          expect(resolve).toHaveBeenCalledTimes(1)
        }
        if (writer === 'batch') {
          await journal.appendLifecycleBatch({
            settlementId: identity.clientMessageId,
            fence: 1,
            mutations: [{ kind: 'item', identity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }]
          })
        }
        if (writer === 'planned') {
          await journal.appendPlannedLifecycleBatch({
            settlementId: identity.clientMessageId,
            fence: 1,
            plan: () => ({
              mutations: [{ kind: 'item', identity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }],
              dispatches: []
            })
          })
        }
        if (writer === 'submission') {
          await journal.appendSubmission({
            clientMessageId: identity.clientMessageId,
            payloadFingerprint: 'fp',
            body,
            fence: 1,
            origin: 'host'
          })
        }
        if (writer === 'queue') {
          await journal.queuedMessages.insert({ messageId: identity.clientMessageId, body })
        }
        expect(
          db
            .prepare(
              'SELECT upload_id FROM agent_session_attachment_claims WHERE upload_id = ? AND session_id = ?'
            )
            .all(id, 'stream')
        ).toHaveLength(1)
      }
      expect(insertion).toHaveBeenCalledTimes(count)
      expect(extraction).toHaveBeenCalledTimes(count)
      expect(acquired).toHaveBeenCalledTimes(count)
      expect(levels).toEqual(Array(count).fill(2))
      process.stdout.write(
        `pr34654-input-contract ${JSON.stringify({ writer, count, old: 10 * count, extractions: extraction.mock.calls.length, insertions: insertion.mock.calls.length, acquired: acquired.mock.calls.length })}\n`
      )
    }
  }
)
