import { expect, it, onTestFinished, vi } from 'vitest'
import { observeNativeJournalSql } from './journal-native-test-instrumentation'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { JournalGoalAttachmentInverse } from './journal-goal-attachment-inverse'
import type { JournalOperationReceipt } from './journal-row-writer'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from './journal-row-schema'
import * as attachmentReferences from '../agent-session-attachments/agent-session-attachment-references'
import {
  commandReceiptFixture,
  writeCommandReceiptTestRecord
} from './command-receipt-test-support'

import {
  fixture,
  commitLevels,
  openJournal,
  text,
  uploadedInput
} from './journal-streamed-revision-contract-test-fixture'

it('resolves after preceding writes and preserves actual output and external receipt durability', async () => {
  const journal = await openJournal()
  const identity = { provider: 'orca' as const, clientMessageId: 'dynamic' }
  let release = () => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = journal.readInOrder(() => barrier)
  const levels = await commitLevels()
  const preceding = journal.appendItem(identity, text('assistant', 'first'), {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  const resolve = () => {
    expect(journal.snapshot().items[0]?.body).toEqual(text('assistant', 'first'))
    return { identity, body: text('assistant', 'second') }
  }
  const following = journal.appendResolvedItem(resolve, {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  release()
  await Promise.all([held, preceding, following])
  expect(levels).toEqual([2, 1])
  levels.length = 0
  const empty = () => null
  expect(
    await journal.appendResolvedItem(empty, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  ).toBeNull()
  expect(levels).toEqual([])

  const database = await openTestJournalHostDatabase(fixture.root)
  const write: JournalOperationReceipt['write'] = (connection, row) => {
    if (!row) {
      throw new Error('missing receipt target')
    }
    writeCommandReceiptTestRecord(connection, 'stream')
    connection.add({
      kind: 'receipt',
      scope: { kind: 'caller', callerKey: 'caller-1' },
      receipt: commandReceiptFixture({
        sessionId: 'stream',
        result: { kind: 'journal-row', epoch: row.epoch, sequence: row.seq }
      })
    })
  }
  let committed = false
  const result = await journal.appendItem(
    identity,
    text('assistant', 'durable receipt'),
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE },
    {
      write,
      committed: () => {
        committed = true
      }
    }
  )
  expect(levels).toEqual([2])
  const receipt = await database.read((read) => read.receipts({ kind: 'global' }, ['operation-1']))
  expect(receipt.get('operation-1')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { sequence: result.cursor.sequence } }
  })
  expect(committed).toBe(true)
  const huge = 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES)
  for (const mode of ['ordinary', 'planned', 'step'] as const) {
    const body = text('assistant', `${huge}${mode}`)
    const plan = () => [
      { kind: 'item' as const, identity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    ]
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
    const database = await openTestJournalHostDatabase(fixture.root)
    let insertions = 0
    onTestFinished(
      observeNativeJournalSql(database, (entry) => {
        if (
          entry.method === 'run' &&
          /^INSERT OR IGNORE INTO agent_session_attachment_claims\b/.test(entry.sql)
        ) {
          insertions += 1
        }
      })
    )
    const extraction = vi.spyOn(attachmentReferences, 'agentSessionAttachmentReferences')
    const acquired = vi.spyOn(JournalGoalAttachmentInverse.prototype, 'acquired')
    const levels = await commitLevels()
    for (const writer of [
      'direct',
      'resolved',
      'step',
      'batch',
      'planned',
      'submission',
      'queue'
    ] as const) {
      insertions = 0
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
          await database.read((read) =>
            read
              .prepare(
                'SELECT upload_id FROM agent_session_attachment_claims WHERE upload_id = ? AND session_id = ?'
              )
              .all(id, 'stream')
          )
        ).toHaveLength(1)
      }
      expect(insertions).toBe(count)
      expect(extraction).toHaveBeenCalledTimes(count)
      expect(acquired).toHaveBeenCalledTimes(count)
      expect(levels).toEqual(Array(count).fill(2))
      process.stdout.write(
        `pr34654-input-contract ${JSON.stringify({ writer, count, old: 10 * count, extractions: extraction.mock.calls.length, insertions, acquired: acquired.mock.calls.length })}\n`
      )
    }
  }
)
