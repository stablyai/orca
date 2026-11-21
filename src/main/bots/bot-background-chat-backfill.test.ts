import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { AgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { backfillBotBackgroundChats } from './bot-background-chat-backfill'
import { BOT_CHAT_NAME } from './bot-home-chat-name'

const NOW = 1_800_000_000_000
const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }
const bots = () => [{ folderWorkspaceId: 'bot-home' }]

let directory: string
let counter = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-bot-background-backfill-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

async function chat(
  store: AgentSessionRecordStore,
  sessionId: string,
  workspaceId: string
): Promise<void> {
  counter += 1
  await store.reserveOwner({
    sessionId,
    location: { executionHostId: 'local', wslDistro: null, workspaceId, workspaceKind: 'folder' },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    expectedFence: null,
    spawnToken: `spawn-${counter}`,
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${String(counter).padStart(32, '0')}`,
      fingerprint: `fp-${counter}`
    },
    now: NOW
  })
}

describe('backfillBotBackgroundChats', () => {
  it("adds a bot's tabless threads once, and leaves its Home chats and other chats alone", async () => {
    const store = await openTestAgentSessionRecordStore(directory)
    await chat(store, 'bot-thread', 'folder:bot-home')
    await chat(store, 'bot-shown', 'folder:bot-home')
    await chat(store, 'retired-home-chat', 'folder:bot-home')
    await chat(store, 'closed-elsewhere', 'folder:other')
    await store.setUserConversationName('retired-home-chat', BOT_CHAT_NAME, 'rename')
    await store.setSessionTabVisibility('bot-shown', true)
    await store.setSessionTabVisibility('bot-thread', false)

    expect(await backfillBotBackgroundChats(store, bots)).toEqual(['bot-thread'])
    expect(store.isSessionInBackground('bot-thread')).toBe(true)
    expect(store.isSessionInBackground('retired-home-chat')).toBe(false)
    expect(store.isSessionInBackground('closed-elsewhere')).toBe(false)

    // Done is recorded: a chat a person later closes is never swept in by another start.
    await store.setSessionTabVisibility('bot-thread', true)
    await store.setSessionTabVisibility('bot-thread', false)
    const reopened = await openTestAgentSessionRecordStore(directory)
    expect(await backfillBotBackgroundChats(reopened, bots)).toEqual([])
    expect(reopened.isSessionInBackground('bot-thread')).toBe(false)
  })
})
