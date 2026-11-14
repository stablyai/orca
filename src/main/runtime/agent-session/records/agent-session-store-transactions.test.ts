import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  composeJournalOperationReceipts,
  onJournalReceiptCommitted
} from '../../../native-chat/agent-session-journal/writing/journal-row-writer'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  closeTestAgentSessionRecordStores,
  openTestAgentSessionDatabase,
  openTestAgentSessionRecordStore,
  withTestAgentSessionDatabase
} from './agent-session-record-store-test-harness'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

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
  function cancellationReceipt(
    store: AgentSessionRecordStore,
    args: Parameters<AgentSessionRecordStore['operationOutcomeReceipt']>[0],
    cut = cancel
  ) {
    const cancelReceipt = store.usageLimitContinueCancelReceipt('chat-a-0001', cut)
    return cancelReceipt
      ? composeJournalOperationReceipts(store.operationOutcomeReceipt(args), cancelReceipt)
      : store.operationOutcomeReceipt(args)
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
    const reopened = await openTestAgentSessionRecordStore(root, { mode: 'observe' })
    return reopened.getOperationRow('client-1', operationId)?.outcome.status
  }

  it.each([false, true])('rolls record and operation back together (insert=%s)', async (insert) => {
    const store = await pendingOperation(insert)
    const receipt = cancellationReceipt(store, {
      callerKey: 'client-1',
      operationId,
      outcome,
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
      (await openTestAgentSessionRecordStore(root, { mode: 'observe' })).getRecord('chat-a-0001')
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
      outcome
    }
    await store.commitOperationReceipt(cancellationReceipt(store, args))
    expect(await persistedStatus()).toBe('pending')
    expect(store.getRecord('chat-a-0001')?.usageLimitContinueCancel).toEqual(cancel)
    await expect(
      store.commitOperationReceipt(cancellationReceipt(store, { ...args, fingerprint: 'other' }))
    ).rejects.toThrow()
    const stale = await openTestAgentSessionRecordStore(root, { mode: 'observe' })
    const otherId = `${NOW}-${'8'.repeat(32)}`
    await store.admitOperation({
      callerKey: 'client-1',
      operationId: otherId,
      fingerprint: 'other',
      now: NOW
    })
    await expect(
      stale.commitOperationReceipt(
        cancellationReceipt(
          stale,
          { ...args, operationId: otherId },
          { ...cancel, resetsAt: NOW + 90_000 }
        )
      )
    ).rejects.toThrow()
    expect(stale.getRecord('chat-a-0001')?.usageLimitContinueCancel).toEqual(cancel)
    expect(
      (await openTestAgentSessionRecordStore(root, { mode: 'observe' })).getRecord('chat-a-0001')
        ?.usageLimitContinueCancel
    ).toEqual(cancel)
  })
  it('applies a staged receipt to the current SQL rows and ignores a discarded receipt', async () => {
    const store = await pendingOperation()
    const args = { callerKey: 'client-1', operationId, outcome }
    const rolledBack = await cancellationReceipt(store, args).stage!({ savedAt: NOW })
    await store.setConversationName('chat-a-0001', 'after')
    rolledBack.settle(undefined)
    expect(store.getRecord('chat-a-0001')?.usageLimitContinueCancel).toBeUndefined()
    expect(store.getOperationRow('client-1', operationId)?.outcome.status).toBe('pending')

    const committed = await cancellationReceipt(store, args).stage!({ savedAt: NOW })
    const database = await openTestAgentSessionDatabase(root)
    committed.settle(await database.effects(committed.effects))
    expect(store.getRecord('chat-a-0001')).toMatchObject({
      conversationName: 'after',
      usageLimitContinueCancel: cancel
    })
    expect(store.getOperationRow('client-1', operationId)?.outcome.status).toBe('succeeded')
  })
  it('composes receipts against the rows written earlier in the same transaction', async () => {
    const store = await pendingOperation()
    const forkedFrom = {
      sessionId: 'chat-parent',
      itemId: 'turn-1',
      childBoundary: { kind: 'start' as const }
    }
    const composed = composeJournalOperationReceipts(
      cancellationReceipt(store, {
        callerKey: 'client-1',
        operationId,
        outcome
      }),
      store.conversationReceipts.forkBoundary('chat-a-0001', forkedFrom)
    )
    const staged = await composed.stage!({ savedAt: NOW })
    const database = await openTestAgentSessionDatabase(root)
    staged.settle(await database.effects(staged.effects))
    const both = { usageLimitContinueCancel: cancel, forkedFrom }
    expect(store.getRecord('chat-a-0001')).toMatchObject(both)
    expect(
      (await openTestAgentSessionRecordStore(root, { mode: 'observe' })).getRecord('chat-a-0001')
    ).toMatchObject(both)
    expect(await persistedStatus()).toBe('succeeded')
  })
  it('publishes actual writer rows before co-staged callbacks and the next store transaction', async () => {
    const store = await pendingOperation()
    const forkedFrom = {
      sessionId: 'chat-parent',
      itemId: 'turn-1',
      childBoundary: { kind: 'start' as const }
    }
    const actual = {
      usageLimitContinueCancel: cancel,
      forkedFrom,
      options: { interactionMode: 'plan' }
    }
    const composed = composeJournalOperationReceipts(
      onJournalReceiptCommitted(
        cancellationReceipt(store, {
          callerKey: 'client-1',
          operationId,
          outcome
        }),
        () => {
          expect(store.getRecord('chat-a-0001')).toMatchObject(actual)
          expect(store.getRecord('chat-a-0001')?.lease.unreconciled).toBe(false)
        }
      ),
      store.conversationReceipts.forkBoundary('chat-a-0001', forkedFrom)
    )
    const staged = await composed.stage!({ savedAt: NOW })
    const other = await openTestAgentSessionRecordStore(root, { mode: 'observe' })
    await other.replaceSessionOptions({
      sessionId: 'chat-a-0001',
      fence: 1,
      options: { interactionMode: 'plan' },
      now: NOW
    })
    expect(store.getRecord('chat-a-0001')?.options?.interactionMode).toBeUndefined()
    const database = await openTestAgentSessionDatabase(root)
    const results = await database.effects(staged.effects)
    staged.settle(results)
    await store.setConversationName('chat-a-0001', 'after')
    expect(store.getRecord('chat-a-0001')).toMatchObject({ ...actual, conversationName: 'after' })
    expect(
      (await openTestAgentSessionRecordStore(root, { mode: 'observe' })).getRecord('chat-a-0001')
    ).toMatchObject({
      ...actual,
      conversationName: 'after'
    })
  })
  it('fences later writes when a committed store acknowledgement has no resolved rows', async () => {
    const store = await pendingOperation()
    const staged = await cancellationReceipt(store, {
      callerKey: 'client-1',
      operationId,
      outcome
    }).stage!({ savedAt: NOW })
    const database = await openTestAgentSessionDatabase(root)
    await database.effects(staged.effects)
    expect(() => staged.settle([])).toThrow('missing store results')
    expect(store.getRecord('chat-a-0001')?.usageLimitContinueCancel).toBeUndefined()
    await expect(store.setConversationName('chat-a-0001', 'stale')).rejects.toThrow(
      'missing store results'
    )
    await withTestAgentSessionDatabase(root, (db) => {
      const row = db
        .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
        .get('chat-a-0001')!
      expect(JSON.parse(String(row.record_json))).toMatchObject({
        usageLimitContinueCancel: cancel
      })
      expect(JSON.parse(String(row.record_json)).conversationName).not.toBe('stale')
    })
  })
})
