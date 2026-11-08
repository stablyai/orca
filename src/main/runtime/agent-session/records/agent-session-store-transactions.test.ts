import { cancelAgentSessionUsageLimitContinue } from '../../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { composeJournalOperationReceipts } from '../../../native-chat/agent-session-journal/writing/journal-row-writer'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  closeTestAgentSessionRecordStores,
  openTestAgentSessionDatabase,
  openTestAgentSessionRecordStore,
  withTestAgentSessionDatabase
} from './agent-session-record-store-test-harness'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const NOW = 1_800_000_000_000

let root: string
let counter = 0

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-session-store-transactions-'))
})

afterEach(async () => {
  await closeTestAgentSessionRecordStores()
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

    await withTestAgentSessionDatabase(root, (db) =>
      db.exec(
        "CREATE TRIGGER refuse_record BEFORE UPDATE ON agent_session_records BEGIN SELECT RAISE(ABORT, 'the write was refused'); END"
      )
    )
    await expect(store.commitOperationReceipt(receipt)).rejects.toThrow('the write was refused')
    await withTestAgentSessionDatabase(root, (db) => db.exec('DROP TRIGGER refuse_record'))

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
  it('stages for the writer, holds later store writes until it settles, and adopts only a committed draft', async () => {
    const store = await pendingOperation()
    const args = { callerKey: 'client-1', operationId, outcome, record: change }
    const rolledBack = await store.operationOutcomeReceipt(args).stage!({ savedAt: NOW })
    expect(rolledBack.effects).toEqual([expect.objectContaining({ kind: 'store' })])
    const rename = store.setConversationName('chat-a-0001', 'after')
    await new Promise(setImmediate)
    expect(store.getRecord('chat-a-0001')?.conversationName).not.toBe('after')

    rolledBack.settle(undefined)
    await rename
    expect(store.getRecord('chat-a-0001')?.usageLimitContinueCancel).toBeUndefined()
    expect(store.getOperationRow('client-1', operationId)?.outcome.status).toBe('pending')

    const committed = await store.operationOutcomeReceipt(args).stage!({ savedAt: NOW })
    committed.settle([null])
    expect(store.getRecord('chat-a-0001')).toMatchObject({
      conversationName: 'after',
      usageLimitContinueCancel: cancel
    })
    expect(store.getOperationRow('client-1', operationId)?.outcome.status).toBe('succeeded')
  })
  it('commits receipts co-staged in one writer command, the later on the earlier draft', async () => {
    const store = await pendingOperation()
    const forkedFrom = {
      sessionId: 'chat-parent',
      itemId: 'turn-1',
      childBoundary: { kind: 'start' as const }
    }
    const composed = composeJournalOperationReceipts(
      store.operationOutcomeReceipt({
        callerKey: 'client-1',
        operationId,
        outcome,
        record: change
      }),
      store.conversationReceipts.forkBoundary('chat-a-0001', forkedFrom)
    )
    const staged = await composed.stage!({ savedAt: NOW })
    const database = await openTestAgentSessionDatabase(root)
    staged.settle(await database.effects(staged.effects))
    const both = { usageLimitContinueCancel: cancel, forkedFrom }
    expect(store.getRecord('chat-a-0001')).toMatchObject(both)
    expect((await openTestAgentSessionRecordStore(root)).getRecord('chat-a-0001')).toMatchObject(
      both
    )
    expect(await persistedStatus()).toBe('succeeded')
  })
})
