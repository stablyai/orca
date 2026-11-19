// A pass's shared reach context must refuse exactly what the per-call refusal refuses, for every kind
// of recipient.
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../shared/agent-session/identity/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../../shared/orchestration/orchestration-session-caller-codes'
import type { AgentSessionRecordReader } from '../../../../orchestration/addressing/session-lineage/structured-session-lineage'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { createStructuredSessionReachContext } from '../../../../orchestration/mailbox/routing/structured-session-mail-address'
import { structuredWorkerProcessIncarnation } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  refuseUndeliverableSessionRecipient,
  refuseUndeliverableSessionRecipientWith,
  type SessionRecipient
} from './session-recipient'

let db: OrchestrationDb | undefined
afterEach(() => {
  db?.close()
  db = undefined
})

function record(
  sessionId: string,
  overrides: Partial<AgentSessionRecord> = {}
): AgentSessionRecord {
  return { ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })), ...overrides }
}

function cleared(sessionId: string, next: string): AgentSessionRecord {
  return record(sessionId, {
    conversationCommand: {
      command: 'clear',
      runtimeFence: 8,
      operationId: `op-clear-${sessionId}`,
      callerKey: 'renderer',
      phase: 'committed',
      state: 'completed',
      replacementSessionId: next
    }
  })
}

function storeOf(
  records: readonly AgentSessionRecord[],
  tabs: readonly string[]
): AgentSessionRecordReader {
  const views = new Map(
    records.map((entry) => [entry.sessionId, agentSessionConversationView(entry)])
  )
  return {
    getRecord: (sessionId) => views.get(sessionId) ?? null,
    listRecords: () => [...views.values()],
    isSessionTabRetired: (sessionId) => !tabs.includes(sessionId)
  }
}

function recipient(sessionId: string): SessionRecipient {
  if (!isOrcaSessionId(sessionId)) {
    throw new Error(`not an Orca session id: ${sessionId}`)
  }
  return { sessionId, address: formatOrcaSessionAddress(sessionId) }
}

const base = (): AgentSessionRecord[] => [
  record('chat-open-1', {
    providerHandleChain: [
      {
        linkId: 'link-1',
        origin: 'created',
        mintedAtFence: 7,
        observedAt: 1_000,
        handle: claudeProviderHandle('provider-chat-open-1', null)
      }
    ]
  }),
  record('chat-retired'),
  cleared('chat-cleared', 'chat-successor'),
  record('chat-successor'),
  cleared('chat-to-remote', 'chat-remote-1'),
  record('chat-remote-1', {
    location: {
      executionHostId: 'ssh:paired-linux',
      wslDistro: null,
      workspaceId: 'ws',
      workspaceKind: 'git-worktree'
    }
  }),
  cleared('chat-to-missing', 'chat-missing-1'),
  cleared('chat-loop-a', 'chat-loop-b'),
  cleared('chat-loop-b', 'chat-loop-a'),
  record('chat-worker-lost')
]

describe('refuseUndeliverableSessionRecipientWith', () => {
  it('refuses exactly what the per-call refusal refuses, for every kind of recipient', () => {
    const database = new OrchestrationDb(':memory:')
    db = database
    database.db
      .prepare(
        `INSERT INTO dispatch_contexts (id, task_id, status, assignee_orca_session_id, process_incarnation)
         VALUES ('ctx-lost', 't-lost', 'completed', 'chat-worker-lost', ?)`
      )
      .run(structuredWorkerProcessIncarnation('chat-worker-lost'))
    const store = storeOf(base(), [
      'chat-open-1',
      'chat-successor',
      'chat-remote-1',
      'chat-worker-lost'
    ])
    const context = createStructuredSessionReachContext(store, database)
    const ids = [
      'chat-open-1',
      'chat-retired',
      'chat-cleared',
      'chat-successor',
      'chat-to-remote',
      'chat-to-missing',
      'chat-loop-a',
      'chat-worker-lost',
      'provider-chat-open-1',
      'chat-unknown-1'
    ]

    const verdicts = Object.fromEntries(
      ids.map((id) => [id, refuseUndeliverableSessionRecipientWith(context, recipient(id), store)])
    )

    expect(verdicts).toEqual(
      Object.fromEntries(
        ids.map((id) => [
          id,
          refuseUndeliverableSessionRecipient(recipient(id), store, database, null)
        ])
      )
    )
    expect(
      Object.fromEntries(Object.entries(verdicts).map(([id, v]) => [id, v?.code ?? null]))
    ).toEqual({
      'chat-open-1': null,
      'chat-retired': CODES.notLive,
      'chat-cleared': null,
      'chat-successor': null,
      'chat-to-remote': CODES.hostBoundary,
      'chat-to-missing': CODES.notLive,
      'chat-loop-a': CODES.notLive,
      'chat-worker-lost': CODES.notLive,
      'provider-chat-open-1': CODES.providerId,
      'chat-unknown-1': CODES.unknown
    })
    expect(verdicts['chat-worker-lost']?.message).toContain('worker identity')
    expect(verdicts['chat-retired']?.message).toContain('its chat was closed')
  })

  it('answers without a store as the per-call refusal does', () => {
    db = new OrchestrationDb(':memory:')
    const context = createStructuredSessionReachContext(null, db)
    const target = recipient('chat-open-1')
    expect(refuseUndeliverableSessionRecipientWith(context, target, null)).toEqual(
      refuseUndeliverableSessionRecipient(target, null, db, null)
    )
    expect(refuseUndeliverableSessionRecipientWith(context, target, null)?.code).toBe(CODES.unknown)
  })
})
