import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { openTestAgentSessionDatabase } from './agent-session-record-store-test-harness'
import type { TeammateHomeBots } from './agent-session-record-home-names'
import { agentSessionRecordShownName } from './agent-session-record-shown-name'

const ROOT = 'home-root'
const NEXT = 'home-next'

function record(sessionId: string, fields: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return { ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })), ...fields }
}

// Alice's Home, continued by a /clear into NEXT, as a store loads it from disk.
async function openStore(teammateHomeBots: TeammateHomeBots): Promise<AgentSessionRecordStore> {
  const root = record(ROOT, {
    conversationCommand: {
      command: 'clear',
      state: 'completed',
      replacementSessionId: NEXT,
      operationId: 'clear-operation',
      callerKey: 'caller',
      phase: 'committed'
    }
  })
  return AgentSessionRecordStore.open({
    journalDatabase: await openTestAgentSessionDatabase(mkdtempSync(join(tmpdir(), 'home-names-'))),
    records: {
      records: new Map([
        [ROOT, root],
        [NEXT, record(NEXT)]
      ]),
      operations: new Map(),
      retiredClaimKeys: [],
      unreadableRecords: new Map(),
      sessionTabs: null
    },
    hostId: 'local',
    legacySessionTabIds: [],
    teammateHomeBots
  })
}

describe('a teammate’s Home titled at the record store’s reads', () => {
  it('titles the chat a /clear continued the Home into, and a fork of it, by the share row', async () => {
    const store = await openStore(() => [
      {
        chatSessionId: 'owner-home',
        shares: [
          {
            kind: 'account',
            shareId: 'share-alice',
            accountId: 'acct-alice',
            name: 'Alice',
            email: 'alice@example.com',
            addedAt: 1,
            homeSessionId: ROOT
          }
        ]
      }
    ])
    expect(store.getRecord(NEXT)?.conversationName).toBe('Alice’s Home')
    expect(store.getConversation(NEXT)?.conversationName).toBe('Alice’s Home')
    // Automatic naming never sticks a title on it.
    expect(await store.compareAndSetConversationName(NEXT, 'Fix the build', null)).toBeNull()
    // A fork reads its source as the writable record; its title still comes through the store.
    const selected = store.selectWritableRecord(NEXT)
    expect(selected.kind).toBe('writable')
    const writable = selected.kind === 'writable' ? selected.record : null
    expect(writable?.conversationName).toBeUndefined()
    expect(agentSessionRecordShownName(store, writable!)).toBe('Alice’s Home')
  })
})
