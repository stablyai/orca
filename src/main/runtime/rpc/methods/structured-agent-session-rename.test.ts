import { afterEach, expect, it, vi } from 'vitest'
import * as naming from '../../../native-chat/agent-session-wire/structured-agent-session-status-feed-deps'
import { StructuredAgentSessionStatusFeed } from '../../../native-chat/agent-session-wire/structured-agent-session-status-feed'
import { countRecordQueries, countStoreWork } from '../../agent-session-scale.test-fixture'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { abandonStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-abandon'
import {
  hostTestState,
  replaceHostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../agent-session-record-store-test-harness'
import {
  call,
  clearStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

afterEach(clearStructuredHostStub)

it.each([10, 100])('filters cold naming notes with linear work for %i healthy rows', async (h) => {
  const rig = hostTestState()
  await abandonStructuredAgentSessionHost(rig.host)
  const healthyIds = Array.from({ length: h - 1 }, (_, i) => `healthy-codex-${i}`)
  const records = [...healthyIds, 'session-codex', 'session-pi', 'session-raw-only'].map(
    (sessionId): AgentSessionRecord => {
      const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
      return {
        ...record,
        provider: sessionId === 'session-pi' ? 'pi' : 'codex',
        conversationName: 'Name',
        conversationNameSource: 'user',
        providerHandleChain: record.providerHandleChain.map((link) => ({
          ...link,
          handle: {
            transport: sessionId === 'session-pi' ? 'pi' : 'codex-app-server',
            agent: sessionId === 'session-pi' ? 'pi' : 'codex',
            nativeId: `provider-${sessionId}`
          }
        }))
      }
    }
  )
  await seedTestAgentSessionRecordStore(rig.root, { records })
  const database = openTestJournalHostDatabase(rig.root)
  database.db
    .prepare(
      "UPDATE agent_session_records SET record_json = json_set(record_json, '$.lease.minimumNextFence', 'bad') WHERE session_id = ?"
    )
    .run('session-codex')
  database.db
    .prepare(
      "UPDATE agent_session_records SET record_json = json_set(record_json, '$.providerHandleChain', 'invalid') WHERE session_id = ?"
    )
    .run('session-raw-only')
  const rawRows = database.db
    .prepare('SELECT session_id, record_json FROM agent_session_records ORDER BY session_id')
    .all()
  await closeTestJournalHostDatabase(rig.root)
  const store = await openTestAgentSessionRecordStore(rig.root)
  const reopened = openTestJournalHostDatabase(rig.root)
  const host = new StructuredAgentSessionHost({
    ...rig.host.deps,
    store,
    journalDatabase: reopened
  })
  replaceHostTestState({ store, host })
  setStructuredAgentSessionHost(host)
  let closeStream = (): void => {}
  try {
    expect(database.isClosed).toBe(true)
    expect(store.getRecord('session-codex')).toBeNull()
    expect(store.getConversation('session-codex')).toMatchObject({
      provider: 'codex',
      conversationName: 'Name'
    })
    expect(() => store.requireWritableRecord('session-codex')).toThrowError(
      expect.objectContaining({
        refusal: expect.objectContaining({ details: { reason: 'recordUnreadable' } })
      })
    )
    expect(store.getConversation('session-pi')).toMatchObject({
      provider: 'pi',
      conversationName: 'Name'
    })
    expect(store.getConversation('session-raw-only')).toBeNull()
    expect(store.getConversation('session-missing')).toBeNull()
    expect(
      store
        .listConversations()
        .map((record) => record.sessionId)
        .sort()
    ).toEqual([...healthyIds, 'session-codex', 'session-pi'].sort())
    expect(rawRows.map((row) => row.session_id)).toEqual(
      [...healthyIds, 'session-codex', 'session-pi', 'session-raw-only'].sort()
    )
    expect(reopened.db.prepare('SELECT session_id FROM journal_sessions').all()).toEqual([])
    expect(host.hasSession('session-codex')).toBe(false)
    expect(host.readStatusSummary('session-codex')).toBeUndefined()
    const work = countStoreWork(store)
    const queries = countRecordQueries(rig.root)
    // Observe the actual cached loader statement even if a future caller reuses it directly.
    reopened.db.prepare('SELECT session_id, record_json FROM agent_session_records ORDER BY rowid')
    const names = vi.spyOn(naming, 'structuredAgentSessionNamingSnapshot')
    const flatten = vi.spyOn(Array.prototype, 'flatMap')
    const unsubscribe = vi.spyOn(StructuredAgentSessionStatusFeed.prototype, 'unsubscribe')
    for (let attempt = 1; attempt <= 3; attempt++) {
      work.reset()
      names.mockClear()
      flatten.mockClear()
      const reply = await call('agentSession.subscribeStatus', null, STRUCTURED_CLIENT, {
        registerSubscriptionCleanup: (_id: string, cleanup: () => void) => {
          closeStream = cleanup
        }
      })
      const measured = { ...work.counts }
      const measuredQueries = queries()
      closeStream()
      closeStream = (): void => {}
      expect(unsubscribe).toHaveBeenCalledTimes(attempt)
      expect(measured).toEqual({
        inventories: 1,
        keyed: h + 1,
        views: 2 * h,
        clones: 0,
        cloneBytes: 0,
        decodes: 0,
        links: 0,
        tabReads: 0
      })
      expect(measuredQueries).toEqual({ executions: 0, rows: 0 })
      expect(names).toHaveBeenCalledTimes(1)
      expect(names.mock.results[0]).toEqual({
        type: 'return',
        value: {
          type: 'snapshot',
          sessions: [],
          namingActiveSessionIds: [],
          conversationNames: [...healthyIds, 'session-pi', 'session-codex'].map((sessionId) => ({
            sessionId,
            conversationName: 'Name'
          }))
        }
      })
      const scans = flatten.mock.contexts.filter(
        (rows) =>
          Array.isArray(rows) &&
          rows.length === 2 &&
          rows.every(
            (row: unknown) =>
              typeof row === 'object' &&
              row !== null &&
              'raw' in row &&
              typeof row.raw === 'object' &&
              row.raw !== null &&
              'sessionId' in row.raw &&
              (row.raw.sessionId === 'session-codex' || row.raw.sessionId === 'session-raw-only')
          )
      )
      expect(scans).toEqual([
        [
          {
            raw: expect.objectContaining({ sessionId: 'session-codex' }),
            conversation: expect.objectContaining({ sessionId: 'session-codex' }),
            reason: expect.any(String)
          },
          {
            raw: expect.objectContaining({ sessionId: 'session-raw-only' }),
            reason: expect.any(String)
          }
        ]
      ])
      expect(reply).toMatchObject({
        result: {
          sessions: [],
          namingActiveSessionIds: [],
          conversationNames: [...healthyIds, 'session-codex'].map((sessionId) => ({
            sessionId,
            conversationName: 'Name'
          }))
        }
      })
    }
    flatten.mockRestore()
    expect(records.every(({ sessionId }) => !host.hasSession(sessionId))).toBe(true)
    expect(records.every(({ sessionId }) => host.readStatusSummary(sessionId) === undefined)).toBe(
      true
    )
    expect(host.hasSession('session-codex')).toBe(false)
    expect(host.readStatusSummary('session-codex')).toBeUndefined()
    expect(rig.acquire).not.toHaveBeenCalled()
    expect(rig.dispatch).not.toHaveBeenCalled()
    expect(
      reopened.db
        .prepare('SELECT session_id, record_json FROM agent_session_records ORDER BY session_id')
        .all()
    ).toEqual(rawRows)
    expect(reopened.db.prepare('SELECT session_id FROM journal_sessions').all()).toEqual([])
  } finally {
    closeStream()
    await abandonStructuredAgentSessionHost(host)
  }
})
