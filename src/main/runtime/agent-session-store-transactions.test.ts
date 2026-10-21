// How a record-store write reaches the chat database: only the rows it changed, each checked with
// the rules a load applies, never inside a caller's own transaction, and never in memory unless the
// rows committed.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const NOW = 1_800_000_000_000

let root: string
let counter = 0

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-session-store-transactions-'))
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

/** Reserve, observe the spawn, prove the handle: a chat with a live writer. */
async function liveChat(
  store: AgentSessionRecordStore,
  sessionId: string
): Promise<AgentSessionRecord> {
  counter += 1
  const reserved = await store.reserveOwner({
    sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    expectedFence: null,
    spawnToken: `spawn-${counter}`,
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${String(counter).padStart(32, '0')}`,
      fingerprint: `fp-${counter}`
    },
    now: NOW
  })
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId,
    fence,
    process: {
      hostId: 'local',
      pid: 4000 + counter,
      processStartTimeMs: NOW,
      spawnToken: `spawn-${counter}`
    },
    now: NOW
  })
  return store.proveOwner({
    sessionId,
    fence,
    link: {
      linkId: `link-${counter}`,
      handle: claudeProviderHandle(`provider-${counter}`, null),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    now: NOW
  })
}

function totalChanges(): number {
  return Number(
    openTestJournalHostDatabase(root).db.prepare('SELECT total_changes() AS n').get()?.n ?? 0
  )
}

describe('writing a transaction', () => {
  it('writes one record row for a renewal of one chat among several', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    await liveChat(store, 'chat-a-0001')
    await liveChat(store, 'chat-b-0002')
    const renewed = await liveChat(store, 'chat-c-0003')
    const before = totalChanges()

    await store.renewLease({
      sessionId: 'chat-c-0003',
      fence: renewed.lease.runtimeFence,
      childProbe: { outcome: 'identity-matched', matchedOn: ['spawn-token'] },
      now: NOW + 10_000
    })

    expect(totalChanges() - before).toBe(1)
    expect(
      (await openTestAgentSessionRecordStore(root)).getRecord('chat-c-0003')?.lease.lastRenewedAt
    ).toBe(NOW + 10_000)
  })

  it('writes nothing for a transaction that changes nothing', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    await liveChat(store, 'chat-a-0001')
    const before = totalChanges()

    await store.renewLeases([])

    expect(totalChanges()).toBe(before)
  })

  // Every mutation lands after the caller's frame, so one made inside an open journal transaction
  // on the same connection never nests a BEGIN there.
  it('runs a store call made inside an open journal transaction after that transaction', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    await liveChat(store, 'chat-a-0001')
    let pending: Promise<unknown> | null = null

    openTestJournalHostDatabase(root).transaction(() => {
      pending = store.setConversationName('chat-a-0001', 'renamed')
    })

    await expect(pending).resolves.toMatchObject({ conversationName: 'renamed' })
    expect((await readPersistedTestAgentSessionStore(root)).records['chat-a-0001']).toMatchObject({
      conversationName: 'renamed'
    })
  })
})

describe('a receipt', () => {
  const operationId = `${NOW}-${'7'.repeat(32)}`
  const outcome = { status: 'succeeded' as const, sessionId: 'chat-a-0001' }

  async function pendingOperation(): Promise<AgentSessionRecordStore> {
    const store = await openTestAgentSessionRecordStore(root)
    await liveChat(store, 'chat-a-0001')
    await store.admitOperation({ callerKey: 'client-1', operationId, fingerprint: 'fp', now: NOW })
    return store
  }

  async function persistedStatus(): Promise<string | undefined> {
    const reopened = await openTestAgentSessionRecordStore(root)
    return reopened.getOperationRow('client-1', operationId)?.outcome.status
  }

  // Written inside the caller's journal transaction, so it commits or rolls back with that write.
  it('shows its rows in memory only once committed is called after the commit', async () => {
    const store = await pendingOperation()
    const receipt = store.operationOutcomeReceipt({ callerKey: 'client-1', operationId, outcome })

    openTestJournalHostDatabase(root).transaction((db) => {
      receipt.write(db)
      expect(store.getOperationRow('client-1', operationId)?.outcome.status).toBe('pending')
    })
    expect(store.getOperationRow('client-1', operationId)?.outcome.status).toBe('pending')
    expect(await persistedStatus()).toBe('succeeded')

    receipt.committed()
    expect(store.getOperationRow('client-1', operationId)?.outcome).toEqual(outcome)
  })

  it('leaves memory and rows as they were when the transaction rolls back', async () => {
    const store = await pendingOperation()
    const receipt = store.operationOutcomeReceipt({ callerKey: 'client-1', operationId, outcome })

    expect(() =>
      openTestJournalHostDatabase(root).transaction((db) => {
        receipt.write(db)
        throw new Error('the journal row was refused')
      })
    ).toThrow('the journal row was refused')

    expect(store.getOperationRow('client-1', operationId)?.outcome.status).toBe('pending')
    expect(await persistedStatus()).toBe('pending')
    // The next store transaction diffs from what committed, not from the discarded draft.
    await store.setConversationName('chat-a-0001', 'after')
    expect(await persistedStatus()).toBe('pending')
  })
})

describe('a change a load would refuse', () => {
  it('rejects a tab id that could not prefix a pane key, and keeps memory and rows as they were', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    await liveChat(store, 'chat-a-0001')
    const persisted = await readPersistedTestAgentSessionStore(root)

    await expect(
      store.setSessionTabVisibility('chat-a-0001', true, 'agent-session:chat-a-0001')
    ).rejects.toThrow('agent_session_store_write_invalid')

    expect(store.getSessionTabId('chat-a-0001')).toBeNull()
    expect(store.getVisibleSessionTabIndex().present).toBe(false)
    expect(await readPersistedTestAgentSessionStore(root)).toEqual(persisted)
  })

  it('rejects a record whose handle chain names a link twice', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    const before = await liveChat(store, 'chat-a-0001')

    await expect(
      store.transitionHandoff('chat-a-0001', (record) => ({
        ...record,
        providerHandleChain: [...record.providerHandleChain, ...record.providerHandleChain]
      }))
    ).rejects.toThrow('agent_session_store_write_invalid')

    expect(store.getRecord('chat-a-0001')).toBe(before)
    expect(
      (await openTestAgentSessionRecordStore(root)).getRecord('chat-a-0001')?.providerHandleChain
    ).toHaveLength(1)
  })
})

describe('rows in memory', () => {
  it('throws on a change made in place, which the row diff would never write', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    await liveChat(store, 'chat-a-0001')
    const loaded = (await openTestAgentSessionRecordStore(root)).getRecord('chat-a-0001')

    expect(() => Object.assign(loaded?.lease ?? {}, { runtimeFence: 99 })).toThrow(TypeError)
    expect(() =>
      Object.assign(store.getRecord('chat-a-0001') ?? {}, { conversationName: 'x' })
    ).toThrow(TypeError)
  })
})

describe('after the database closes', () => {
  // Late settlement at quit lands here: the caller reports it, and nothing in memory moves.
  it('refuses a write with journal_closed and leaves memory as it was', async () => {
    const store = await openTestAgentSessionRecordStore(root)
    const before = await liveChat(store, 'chat-a-0001')
    closeTestJournalHostDatabases()

    await expect(store.setConversationName('chat-a-0001', 'late')).rejects.toMatchObject({
      code: 'journal_closed'
    })
    expect(store.getRecord('chat-a-0001')).toBe(before)
  })
})
