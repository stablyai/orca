import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleFacts,
  lifecycleTarget as target
} from './journal-domain-lifecycle.test-fixture'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { JournalSqlScope } from './journal-sql-scope'
import {
  journalDomainEnteredInputs,
  journalDomainSendingInputs
} from './journal-domain-input-populations'
import { openJournalDatabase, runJournalTransaction } from './database/journal-database'
import { publishJournalOutcomeEpoch } from './outcomes/journal-outcome-epoch.test-fixture'
import { insertJournalRow, publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import type { JournalRow } from './durable-rows/journal-row-schema'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { prepareJournalDomainImport } from './journal-domain-import'
import {
  finishJournalDomainImport,
  insertJournalDomainImportPage
} from './journal-domain-import-rows'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

it('keeps queued and entered membership through handover, refresh, atomic groups and rollback', async () => {
  const f = domainLifecycleFixture(cleanups)
  const phase = (name: 'sending' | 'entered') =>
    [
      ...(name === 'sending' ? journalDomainSendingInputs : journalDomainEnteredInputs)(
        new JournalSqlScope(f.db, 'chat', 'epoch')
      )
    ]
      .map((send) => send.clientMessageId)
      .sort()
  const admit = (id: string, held = false) =>
    f.run({
      kind: 'submission',
      input: {
        clientMessageId: id,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
        payloadFingerprint: id,
        fence: 1,
        ...(held ? { handoverRecorded: true } : {})
      }
    })
  await admit('A', true)
  await admit('B')
  expect(phase('sending')).toEqual(['A', 'B'])
  expect(phase('entered')).toEqual(['B'])
  await f.run({
    kind: 'dispatch',
    input: { clientMessageId: 'A', state: 'pending', fence: 1, turnScope: { kind: 'thread' } }
  })
  await admit('C')
  expect(phase('entered')).toEqual(['A', 'B', 'C'])
  await f.run({ kind: 'dispatch', input: { clientMessageId: 'A', state: 'unknown', fence: 1 } })
  expect(phase('sending')).toEqual(['B', 'C'])
  expect(phase('entered')).toEqual(['A', 'B', 'C'])
  await f.run({
    kind: 'dispatch',
    input: { clientMessageId: 'A', state: 'pending', fence: 1, turnScope: { kind: 'thread' } }
  })
  expect(phase('sending')).toEqual(['A', 'B', 'C'])
  expect(phase('entered')).toEqual(['A', 'B', 'C'])
  await f.run({
    kind: 'dispatch',
    input: { clientMessageId: 'B', state: 'pending', fence: 1, turnScope: { kind: 'thread' } }
  })
  expect(phase('sending')).toEqual(['A', 'B', 'C'])
  expect(phase('entered')).toEqual(['A', 'B', 'C'])
  await f.run({
    kind: 'lifecycle',
    input: {
      settlementId: 'phase-transition',
      fence: 1,
      mutations: [],
      dispatches: [
        { clientMessageId: 'B', state: 'unknown', fence: 1 },
        { clientMessageId: 'B', state: 'pending', fence: 1, turnScope: { kind: 'thread' } }
      ]
    }
  })
  expect(phase('sending')).toEqual(['A', 'B', 'C'])
  expect(phase('entered')).toEqual(['A', 'B', 'C'])
  f.db.exec('BEGIN IMMEDIATE')
  applyJournalDomainDispatch(
    f.db,
    target,
    {
      kind: 'dispatch',
      input: { clientMessageId: 'A', state: 'accepted', fence: 1, providerIdentity: null }
    },
    100
  )
  expect(phase('sending')).toEqual(['B', 'C'])
  expect(phase('entered')).toEqual(['B', 'C'])
  f.db.exec('ROLLBACK')
  expect(phase('sending')).toEqual(['A', 'B', 'C'])
  expect(phase('entered')).toEqual(['A', 'B', 'C'])
  await f.run({
    kind: 'dispatch',
    input: { clientMessageId: 'A', state: 'accepted', providerIdentity: null, fence: 1 }
  })
  await f.run({
    kind: 'dispatch',
    input: { clientMessageId: 'A', state: 'pending', fence: 1, turnScope: { kind: 'thread' } }
  })
  f.reopen()
  expect(phase('sending')).toEqual(['B', 'C'])
  expect(phase('entered')).toEqual(['B', 'C'])
})

it.each([false, true])(
  'imports current dispatch membership (outcome=%s) and keeps it on reopen',
  (outcome) => {
    const f = domainLifecycleFixture(cleanups)
    const { db: source } = openJournalDatabase(':memory:')
    cleanups.push(() => source.close())
    const providerHandle = agentSessionJournalProviderHandle(lifecycleFacts.identity)
    const base = { v: 4, epoch: 'epoch', seq: 1, ts: 100, fence: 1 }
    const rows: JournalRow[] = [
      { ...base, kind: 'epoch', reason: 'session_created', providerHandle },
      ...['A', 'B'].map((id, index): JournalRow => ({
        ...base,
        seq: index + 2,
        kind: 'submission',
        clientMessageId: id,
        providerHandle,
        payloadFingerprint: id,
        ...(id === 'A' ? { handoverRecorded: true } : {}),
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }
      })),
      {
        ...base,
        seq: 4,
        kind: 'dispatch',
        clientMessageId: 'A',
        state: 'pending',
        providerItemId: null,
        reason: null,
        turnScope: { kind: 'thread' }
      },
      {
        ...base,
        seq: 5,
        kind: 'submission',
        clientMessageId: 'C',
        providerHandle,
        payloadFingerprint: 'C',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'C' }] }
      },
      {
        ...base,
        seq: 6,
        kind: 'dispatch',
        clientMessageId: 'A',
        state: 'unknown',
        providerItemId: null,
        reason: null
      },
      {
        ...base,
        seq: 7,
        kind: 'dispatch',
        providerItemId: null,
        reason: null,
        clientMessageId: 'A',
        state: 'pending',
        turnScope: { kind: 'thread' }
      }
    ]
    runJournalTransaction(source, () => {
      publishJournalSessionEpoch(source, { sessionId: 'chat', workspaceId: 'workspace' }, 'epoch')
      if (outcome) {
        publishJournalOutcomeEpoch(source, 'chat', 'epoch', rows)
      } else {
        for (const row of rows) {
          insertJournalRow(source, 'chat', row)
        }
      }
    })
    f.db.exec('DELETE FROM journal_chat_state')
    const imported = prepareJournalDomainImport(source, 'chat')!
    for (const page of imported.pages) {
      runJournalTransaction(f.db, () => insertJournalDomainImportPage(f.db, imported, page))
    }
    runJournalTransaction(f.db, () => finishJournalDomainImport(f.db, imported))
    f.reopen()
    const scope = new JournalSqlScope(f.db, 'chat', 'epoch')
    expect(
      [...journalDomainSendingInputs(scope)].map((send) => send.clientMessageId).sort()
    ).toEqual(['A', 'B', 'C'])
    expect(
      [...journalDomainEnteredInputs(scope)].map((send) => send.clientMessageId).sort()
    ).toEqual(['A', 'B', 'C'])
    expect(
      f.db
        .prepare(
          `SELECT message_id FROM journal_submission_attempts WHERE current=1 ORDER BY ordinal,message_id`
        )
        .all()
        .map((row) => row.message_id)
    ).toEqual(['A', 'B', 'C'])
  }
)
