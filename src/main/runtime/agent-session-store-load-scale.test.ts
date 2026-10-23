import { describe, expect, it } from 'vitest'
import {
  countRecordQueries,
  countStoreWork,
  scaleJournal,
  scaleDirectory,
  scaleRecord,
  stringify
} from './agent-session-scale.test-fixture'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'

// Width, link count and malformed bytes vary independently; no clock-dependent budget.
describe('SQLite conversation reopen work', () => {
  it.each([
    [10, 1, 16],
    [100, 1, 16],
    [10, 10, 16],
    [10, 1, 64_000]
  ])('decodes %i damaged rows with %i links and %i floor bytes once', async (n, links, bytes) => {
    const root = await scaleDirectory()
    const records = Array.from({ length: n }, (_, i) =>
      scaleRecord(`damaged-${i}`, 'workspace-1', links)
    )
    await seedTestAgentSessionRecordStore(root, {
      records: [...records, scaleRecord('healthy-chat'), scaleRecord('invalid-chat')]
    })
    await editPersistedTestAgentSessionStore(root, (state) => {
      for (const record of records) {
        Object.assign(state.records[record.sessionId].lease, {
          minimumNextFence: { bad: 'x'.repeat(bytes) }
        })
      }
      Object.assign(state.records['invalid-chat'], { providerHandleChain: 'bad' })
    })
    const raw = await readPersistedTestAgentSessionStore(root)
    const expectedBytes = records.reduce(
      (sum, row) => sum + Buffer.byteLength(stringify(raw.records[row.sessionId])),
      0
    )
    const journal = await scaleJournal(root, 'damaged-0')
    await journal.appendItem(
      { provider: 'claude', sessionId: 'provider-damaged-0-0', uuid: 'saved-question' },
      hostTestMessage('saved question'),
      { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.close()
    const work = countStoreWork()
    const queries = countRecordQueries(root)
    const store = await openTestAgentSessionRecordStore(root)
    expect(queries()).toEqual({ executions: 1, rows: n + 2 })
    expect(work.counts).toMatchObject({
      clones: n,
      cloneBytes: expectedBytes,
      views: n + 1,
      decodes: 4 * n + 5,
      links: 4 * n * links + 2
    })
    const loaded = { ...work.counts }
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const row of records) {
        expect(store.getConversation(row.sessionId)?.options?.model).toBe('saved-model')
        expect(store.getRecord(row.sessionId)).toBeNull()
        expect(() => store.requireWritableRecord(row.sessionId)).toThrow()
      }
    }
    expect(store.getConversation('invalid-chat')).toBeNull()
    expect(store.listHeldSessionIds()).toContain('invalid-chat')
    expect(work.counts).toEqual(loaded)
    await store.setConversationName('healthy-chat', 'renamed')
    expect(work.counts.clones).toBe(n)
    expect(queries()).toEqual({ executions: 1, rows: n + 2 })
    const after = await readPersistedTestAgentSessionStore(root)
    for (const row of records) {
      expect(after.records[row.sessionId]).toEqual(raw.records[row.sessionId])
    }
    expect(after.records['healthy-chat'].conversationName).toBe('renamed')
    const reopened = await scaleJournal(root, 'damaged-0')
    expect(reopened.snapshot().items.map((item) => item.body)).toContainEqual(
      hostTestMessage('saved question')
    )
    expect(store.getConversation('damaged-0')?.providerHandleChain[0]?.handle.nativeId).toBe(
      'provider-damaged-0-0'
    )
  })
})
