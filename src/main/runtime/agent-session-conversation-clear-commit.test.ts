import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  providerContextBoundaryForClear,
  type AgentSessionConversationClear
} from './agent-session-conversation-command-record'
import { isAgentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { agentSessionOperationKey } from '../../shared/agent-session-operation-ledger'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'

const NOW = 1_800_000_000_000
const SOURCE = 'session-alpha'
const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-clear-commit-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const open = () => openTestAgentSessionRecordStore(directory)

async function storeWithSource(): Promise<AgentSessionRecordStore> {
  const store = await open()
  await store.reserveOwner({
    sessionId: SOURCE,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    launchArgs: ['--flag'],
    options: { model: 'sonnet' },
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${'1'.repeat(32)}`,
      fingerprint: 'fp'
    },
    now: NOW
  })
  const fence = store.getRecord(SOURCE)!.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SOURCE,
    fence,
    process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken: 'spawn-a' },
    now: NOW
  })
  await store.proveOwner({
    sessionId: SOURCE,
    fence,
    link: {
      linkId: 'pre-clear-proof',
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW,
      handle: claudeProviderHandle('pre-clear-provider-context', null)
    },
    now: NOW
  })
  await store.setSessionTabVisibility(SOURCE, true, 'tab-alpha')
  return store
}

function clear(fence: number): AgentSessionConversationClear {
  return {
    sessionId: SOURCE,
    fence,
    now: NOW + 5,
    command: {
      command: 'clear',
      state: 'completed',
      phase: 'committed',
      runtimeFence: fence,
      operationId: `${NOW}-${'2'.repeat(32)}`,
      callerKey: 'client-1'
    }
  }
}

async function prepare(released = true) {
  const store = await storeWithSource()
  if (released) {
    await store.evictProvenDeadOwner({
      sessionId: SOURCE,
      expectedFence: store.getRecord(SOURCE)!.lease.runtimeFence,
      probe: { outcome: 'exit-observed' },
      now: NOW + 1
    })
  }
  const journal = new AgentSessionJournal({
    database: openTestJournalHostDatabase(directory),
    identity: {
      sessionId: SOURCE,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: null
    },
    now: () => NOW + 5
  })
  await journal.open()
  const completed = clear(store.getRecord(SOURCE)!.lease.runtimeFence)
  const operation = {
    callerKey: completed.command.callerKey,
    operationId: completed.command.operationId
  }
  await store.admitOperation({ ...operation, fingerprint: 'clear', now: NOW })
  const append = (input = completed) =>
    journal.context.clear(
      providerContextBoundaryForClear(input),
      store.conversationReceipts.clear(() => input, operation),
      agentSessionOperationKey(operation.callerKey, operation.operationId)
    )
  return { store, journal, completed, operation, append }
}

async function queueClearCards(journal: AgentSessionJournal) {
  for (const messageId of ['first', 'command', 'last']) {
    await journal.queuedMessages.insert({
      messageId,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: messageId }],
        ...(messageId === 'command' ? { command: { name: 'compact' } } : {})
      },
      fingerprint: messageId,
      hostInstance: 'host-1'
    })
  }
}

describe('clear transaction', () => {
  it('publishes one boundary and receipt while preserving the record and tab on disk', async () => {
    const { store, journal, completed, operation, append } = await prepare()
    const before = store.getRecord(SOURCE)!
    expect(before.providerHandleChain).toHaveLength(1)
    await queueClearCards(journal)
    const epoch = journal.cursor().epoch
    await append()
    const reopened = await open()
    expect(reopened.listRecords()).toHaveLength(1)
    expect(reopened.getRecord(SOURCE)).toMatchObject({
      providerContextBoundary: providerContextBoundaryForClear(completed),
      providerHandleChain: [],
      lease: { provenHandleLinkId: null },
      accountHome: before.accountHome,
      options: before.options,
      conversationCommand: completed.command
    })
    expect(reopened.getSessionTabId(SOURCE)).toBe('tab-alpha')
    expect(JSON.stringify(reopened.getRecord(SOURCE))).not.toContain('pre-clear-provider-context')
    expect(journal.cursor().epoch).toBe(epoch)
    expect(journal.queuedMessages.get('command')).toMatchObject({
      state: 'withdrawn',
      settledByOp: agentSessionOperationKey(operation.callerKey, operation.operationId)
    })
    expect(journal.queuedMessages.pauses()).toMatchObject([{ messageIds: ['first', 'last'] }])
    expect(
      reopened.getOperationRow(operation.callerKey, operation.operationId)?.outcome.status
    ).toBe('succeeded')
  })

  it('rolls the divider and receipt back when the fence moved', async () => {
    const { store, journal, completed, operation, append } = await prepare()
    await queueClearCards(journal)
    const before = journal.cursor()
    const previousChain = store.getRecord(SOURCE)!.providerHandleChain
    const refused = await append({ ...completed, fence: completed.fence + 1 }).catch(
      (error: unknown) => error
    )
    expect(isAgentSessionRefusalError(refused)).toBe(true)
    expect(journal.cursor()).toEqual(before)
    expect(
      journal.queuedMessages.list().map(({ messageId, state }) => ({ messageId, state }))
    ).toEqual(['first', 'command', 'last'].map((messageId) => ({ messageId, state: 'waiting' })))
    expect(journal.queuedMessages.pauses()).toEqual([])
    expect((await open()).getRecord(SOURCE)?.providerContextBoundary).toBeUndefined()
    expect((await open()).getRecord(SOURCE)?.providerHandleChain).toEqual(previousChain)
    expect(store.getOperationRow(operation.callerKey, operation.operationId)?.outcome.status).toBe(
      'pending'
    )
  })

  it('refuses a boundary while ownership is still reserved', async () => {
    const { store, journal, append } = await prepare(false)
    const before = journal.cursor()
    await expect(append()).rejects.toMatchObject({
      refusal: { code: 'agent_session_ownership_unknown' }
    })
    expect(journal.cursor()).toEqual(before)
    expect(store.getRecord(SOURCE)?.providerContextBoundary).toBeUndefined()
  })
})
