import { cancelAgentSessionUsageLimitContinue } from '../../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const NOW = 1_800_000_000_000

let root: string
let counter = 0

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-session-store-transactions-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

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

describe('writing a transaction', () => {
  // Defer BEGIN beyond the caller's frame to avoid nesting its open journal transaction.
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

  const cancel = {
    turnItemId: `orca:${'long-supported-identity'.repeat(220)}`,
    resetsAt: NOW + 60_000
  }
  const change = {
    sessionId: 'chat-a-0001',
    update: (record: AgentSessionRecord) => cancelAgentSessionUsageLimitContinue(record, cancel)
  }
  async function pendingOperation(insert = false): Promise<AgentSessionRecordStore> {
    const store = await openTestAgentSessionRecordStore(root)
    await liveChat(store, 'chat-a-0001')
    if (!insert) {
      await store.admitOperation({
        callerKey: 'client-1',
        operationId,
        fingerprint: 'fp',
        now: NOW
      })
    }
    return store
  }

  async function persistedStatus(): Promise<string | undefined> {
    const reopened = await openTestAgentSessionRecordStore(root)
    return reopened.getOperationRow('client-1', operationId)?.outcome.status
  }

  it.each([false, true])('rolls record and operation back together (insert=%s)', async (insert) => {
    const store = await pendingOperation(insert)
    const receipt = store.operationOutcomeReceipt({
      callerKey: 'client-1',
      operationId,
      outcome,
      record: change,
      ...(insert ? { fingerprint: 'fp', now: NOW } : {})
    })

    expect(() =>
      openTestJournalHostDatabase(root).transaction((db) => {
        receipt.write(db)
        throw new Error('the journal row was refused')
      })
    ).toThrow('the journal row was refused')

    expect(store.getOperationRow('client-1', operationId)?.outcome.status).toBe(
      insert ? undefined : 'pending'
    )
    expect(await persistedStatus()).toBe(insert ? undefined : 'pending')
    expect(store.getRecord('chat-a-0001')?.usageLimitContinueCancel).toBeUndefined()
    expect(
      (await openTestAgentSessionRecordStore(root)).getRecord('chat-a-0001')
        ?.usageLimitContinueCancel
    ).toBeUndefined()
    // A discarded draft must not become the next diff baseline.
    await store.setConversationName('chat-a-0001', 'after')
    expect(await persistedStatus()).toBe(insert ? undefined : 'pending')
  })
  it('keeps an existing operation identity and rolls a competing insertion back with its record', async () => {
    const store = await pendingOperation()
    const args = {
      callerKey: 'client-1',
      operationId,
      fingerprint: 'fp',
      now: NOW,
      outcome,
      record: change
    }
    await store.commitOperationReceipt(store.operationOutcomeReceipt(args))
    expect(await persistedStatus()).toBe('pending')
    expect(store.getRecord('chat-a-0001')?.usageLimitContinueCancel).toEqual(cancel)
    await expect(
      store.commitOperationReceipt(store.operationOutcomeReceipt({ ...args, fingerprint: 'other' }))
    ).rejects.toThrow()
    const stale = await openTestAgentSessionRecordStore(root)
    const otherId = `${NOW}-${'8'.repeat(32)}`
    await store.admitOperation({
      callerKey: 'client-1',
      operationId: otherId,
      fingerprint: 'other',
      now: NOW
    })
    await expect(
      stale.commitOperationReceipt(
        stale.operationOutcomeReceipt({
          ...args,
          operationId: otherId,
          record: { ...change, update: (r) => ({ ...r, conversationName: 'lost' }) }
        })
      )
    ).rejects.toThrow()
    expect(stale.getRecord('chat-a-0001')?.conversationName).not.toBe('lost')
    expect(
      (await openTestAgentSessionRecordStore(root)).getRecord('chat-a-0001')?.conversationName
    ).not.toBe('lost')
  })
})
