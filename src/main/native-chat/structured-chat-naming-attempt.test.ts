import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { closeTestJournalHostDatabase } from './agent-session-journal/journal-host-database-test-support'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { createStructuredChatNamingHandler } from './structured-chat-naming'

it.each(['claude', 'codex'] as const)(
  'keeps a failed automatic %s title until explicit Regenerate',
  async (provider) => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-naming-attempt-'))
    vi.useFakeTimers()
    try {
      const record = { ...agentSessionRecordFixture(), provider }
      await seedTestAgentSessionRecordStore(directory, { records: [record] })
      const store = await openTestAgentSessionRecordStore(directory)
      const naming = createStructuredChatNamingHandler({
        getStore: () => store,
        getSettings: () => ({}),
        readFirstPrompt: async () => 'Explain migrations',
        readJournalFirstPrompt: async () => 'Explain migrations',
        workerTaskTitle: () => null,
        generate: vi
          .fn()
          .mockResolvedValueOnce({ error: 'Naming unavailable' })
          .mockResolvedValue({ name: 'Migration guide' }),
        onNamed: () => {},
        logger: { warn: () => {}, error: () => {} }
      })
      naming(
        {
          sessionId: record.sessionId,
          workspaceId: record.location.workspaceId,
          agent: provider,
          status: 'working',
          updatedAt: 100
        },
        { replay: false }
      )
      await vi.runAllTimersAsync()
      expect(store.getRecord(record.sessionId)?.conversationName).toBe('Explain migrations')
      expect(naming.failure(record.sessionId)).toMatchObject({ message: 'Naming unavailable' })
      expect(naming.regenerate(record.sessionId)).toBe(true)
      await vi.runAllTimersAsync()
      expect(store.getRecord(record.sessionId)?.conversationName).toBe('Migration guide')
      expect(naming.failure(record.sessionId)).toBeUndefined()
    } finally {
      vi.useRealTimers()
      await closeTestJournalHostDatabase(directory)
      await rm(directory, { recursive: true, force: true })
    }
  }
)
