import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { isPersistedAgentSessionRecord } from '../../shared/agent-session-record'
import { record } from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'

it('commits permission intent and revision atomically, and discards both after a database refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-permission-atomic-'))
  const saved = {
    ...record({ chain: [] }),
    options: { permissionMode: 'ask' },
    permissionRevision: 9
  }
  await seedTestAgentSessionRecordStore(root, { records: [saved] })
  let store = await openTestAgentSessionRecordStore(root)
  const database = openTestJournalHostDatabase(root)
  try {
    database.db.exec(`CREATE TRIGGER reject_permission BEFORE UPDATE ON agent_session_records
      WHEN json_extract(new.record_json, '$.options.permissionMode') = 'bypass'
      BEGIN SELECT RAISE(ABORT, 'permission write refused'); END`)
    await expect(
      store.replaceSessionOptions({
        sessionId: saved.sessionId,
        fence: 1,
        options: { permissionMode: 'bypass' },
        now: 1
      })
    ).rejects.toThrow('permission write refused')
    expect(store.getRecord(saved.sessionId)).toMatchObject({
      options: saved.options,
      permissionRevision: 9
    })
    expect((await readPersistedTestAgentSessionStore(root)).records[saved.sessionId]).toMatchObject(
      {
        options: saved.options,
        permissionRevision: 9
      }
    )
    database.db.exec('DROP TRIGGER reject_permission')
    await Promise.all(
      ['bypass', 'ask', 'bypass'].map((permissionMode) =>
        store.replaceSessionOptions({
          sessionId: saved.sessionId,
          fence: 1,
          options: { permissionMode },
          now: 1
        })
      )
    )
    expect((await readPersistedTestAgentSessionStore(root)).records[saved.sessionId]).toMatchObject(
      {
        options: { permissionMode: 'bypass' },
        permissionRevision: 12
      }
    )
    closeTestJournalHostDatabase(root)
    store = await openTestAgentSessionRecordStore(root)
    expect(store.permissionRevision(saved.sessionId)).toBe(12)
    await store.replaceSessionOptions({
      sessionId: saved.sessionId,
      fence: 1,
      options: { permissionMode: 'ask' },
      now: 0
    })
    expect(store.permissionRevision(saved.sessionId)).toBe(13)
  } finally {
    closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

it('starts absent order at zero without writing, regardless of stored timestamps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-permission-legacy-'))
  const saved = { ...record({ chain: [] }), options: { permissionMode: 'ask' } }
  await seedTestAgentSessionRecordStore(root, { records: [saved] })
  let store = await openTestAgentSessionRecordStore(root)
  try {
    const baseline = 0
    expect(store.permissionRevision(saved.sessionId)).toBe(baseline)
    expect(
      (await readPersistedTestAgentSessionStore(root)).records[saved.sessionId]?.permissionRevision
    ).toBeUndefined()
    closeTestJournalHostDatabase(root)
    store = await openTestAgentSessionRecordStore(root)
    expect(store.permissionRevision(saved.sessionId)).toBe(baseline)
    await store.replaceSessionOptions({
      sessionId: saved.sessionId,
      fence: 1,
      options: { permissionMode: 'ask', model: 'm' },
      now: 0
    })
    expect(store.permissionRevision(saved.sessionId)).toBe(baseline)
    closeTestJournalHostDatabase(root)
    store = await openTestAgentSessionRecordStore(root)
    expect(store.permissionRevision(saved.sessionId)).toBe(baseline)
    await store.replaceSessionOptions({
      sessionId: saved.sessionId,
      fence: 1,
      options: { permissionMode: 'bypass' },
      now: 0
    })
    expect(store.permissionRevision(saved.sessionId)).toBe(baseline + 1)
  } finally {
    closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', null])(
  'refuses malformed stored permission revision %s',
  (permissionRevision) => {
    expect(isPersistedAgentSessionRecord({ ...record({ chain: [] }), permissionRevision })).toBe(
      false
    )
  }
)

it('accepts absent order fields', () => {
  expect(isPersistedAgentSessionRecord(record({ chain: [] }))).toBe(true)
})

it('stamps journal receipt intent and order together and preserves both when its transaction rolls back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-permission-receipt-'))
  const saved = {
    ...record({ chain: [] }),
    options: { permissionMode: 'ask' },
    permissionRevision: 9
  }
  await seedTestAgentSessionRecordStore(root, { records: [saved] })
  const database = openTestJournalHostDatabase(root)
  const { AgentSessionStoreTransactions } = await import('./agent-session-store-transactions')
  const { loadAgentSessionStoreRows } = await import('./agent-session-record-rows')
  const transactions = new AgentSessionStoreTransactions(
    database,
    loadAgentSessionStoreRows(database.db)
  )
  const receipt = (permissionMode: string) =>
    transactions.receipt((draft) => {
      const before = draft.records.get(saved.sessionId)
      if (!before) {
        throw new Error('Missing record')
      }
      draft.records.set(saved.sessionId, {
        ...before,
        options: { permissionMode },
        permissionRevision: 0
      })
    })
  try {
    const committed = receipt('bypass')
    database.transaction((db) => committed.write(db))
    committed.committed()
    expect(transactions.permissionRevision(saved.sessionId)).toBe(10)
    expect((await readPersistedTestAgentSessionStore(root)).records[saved.sessionId]).toMatchObject(
      {
        options: { permissionMode: 'bypass' },
        permissionRevision: 10
      }
    )
    const refused = receipt('ask')
    expect(() =>
      database.transaction((db) => {
        refused.write(db)
        throw new Error('receipt refused')
      })
    ).toThrow('receipt refused')
    expect(transactions.state.records.get(saved.sessionId)).toMatchObject({
      options: { permissionMode: 'bypass' },
      permissionRevision: 10
    })
    expect((await readPersistedTestAgentSessionStore(root)).records[saved.sessionId]).toMatchObject(
      { options: { permissionMode: 'bypass' }, permissionRevision: 10 }
    )
  } finally {
    closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})
