import { nextStructuredQueuedMessage } from '../native-chat/agent-session-wire/structured-agent-session-queued-messages'
import { heldStructuredAgentSessionCurrentWork } from '../native-chat/agent-session-wire/structured-agent-session-host-current-work'
import { AgentSessionSubscribers } from '../native-chat/agent-session-wire/structured-agent-session-subscribers'
import { openStructuredAgentSessionConversationJournal } from '../native-chat/agent-session-wire/structured-agent-session-conversation-open'
import { readStructuredAgentSessionHistoryResult } from '../native-chat/agent-session-wire/structured-agent-session-history-result'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AgentSessionConversationView } from '../../shared/agent-session-conversation-view'
import type { nextAgentSessionFence } from '../../shared/agent-session-next-fence'
import { listStructuredProviderSessionOwnership } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import { findConflictingStructuredAdoption } from '../native-chat/structured-agent-session-history-adoption'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionReserveRequest } from './agent-session/ownership/agent-session-reservation-admission'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'

const NOW = 1_800_000_000_000
const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

const INDETERMINATE = { outcome: 'indeterminate', reason: 'no answer' } as const

let counter = 0

function operationId(now = NOW): string {
  counter += 1
  return `${now}-${String(counter)
    .padStart(32, '0')
    .replaceAll(/[^0-9a-f]/g, '0')}`
}

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: 'session-alpha',
    location: NATIVE,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  }
}

function processIdentity(
  overrides: Partial<AgentSessionProcessIdentity> = {}
): AgentSessionProcessIdentity {
  return {
    hostId: 'local',
    pid: 4242,
    processStartTimeMs: 1_700_000_000_000,
    spawnToken: 'spawn-a',
    ...overrides
  }
}

function handleLink(
  overrides: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId: 'link-1',
    handle: claudeProviderHandle('provider-session-1', 'leaf-1'),
    origin: 'created',
    mintedAtFence: 1,
    observedAt: NOW,
    ...overrides
  }
}

let directory: string

async function open(hostId = 'local'): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(directory, { hostId })
}

/** Reserve, observe the spawn, prove the handle — the full path to an admitted writer. */
async function establishOwner(
  store: AgentSessionRecordStore,
  overrides: Partial<AgentSessionReserveRequest> = {}
): Promise<AgentSessionRecord> {
  const reserved = await store.reserveOwner(reserveRequest(overrides))
  const fence = reserved.record.lease.runtimeFence
  const sessionId = reserved.record.sessionId
  await store.commitProcessIdentity({
    sessionId,
    fence,
    process: processIdentity({ spawnToken: reserved.record.lease.reservedSpawnToken ?? 'spawn-a' }),
    now: NOW
  })
  return store.proveOwner({
    sessionId,
    fence,
    link: handleLink({ mintedAtFence: fence }),
    now: NOW
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-store-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

describe('damaged saved conversation observations', () => {
  it('retains the durable claim for a damaged owner in preflight and transactional adoption', async () => {
    const first = await open()
    await establishOwner(first)
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      Object.assign(persisted.records['session-alpha'].lease, { minimumNextFence: 'bad' })
    })
    const store = await open()
    const ownership = listStructuredProviderSessionOwnership(store.listConversations())
    expect(
      findConflictingStructuredAdoption({
        agent: 'claude',
        providerSessionId: 'provider-session-1',
        selfSessionId: 'session-beta',
        ownership
      })?.sessionId
    ).toBe('session-alpha')
    const adopted = reserveRequest({ sessionId: 'session-beta', adoptedHandleLink: handleLink() })
    await expect(store.founding.commit(adopted)).rejects.toMatchObject({
      refusal: {
        details: { reason: 'conversationHeldElsewhere' }
      }
    })
    await expect(store.reserveOwner(adopted)).rejects.toMatchObject({
      refusal: {
        details: { reason: 'conversationHeldElsewhere' }
      }
    })
    expect(store.getConversation('session-beta')).toBeNull()
  })

  it('does not manufacture never-started or runtime authority from a present malformed floor', async () => {
    const first = await open()
    await first.founding.commit(reserveRequest())
    expect(first.getConversation('session-alpha')?.neverStarted).toBe(true)
    const healthyOwner = first.getConversation('session-alpha')?.ownerObservation
    expect(Object.keys(healthyOwner ?? {}).sort()).toEqual(
      [
        'claimStatus',
        'handoffStage',
        'handoffOperationId',
        'ownerProcess',
        'reservedSpawnToken',
        'provenHandleLinkId',
        'leaseDeadlineAt',
        'lastRenewedAt',
        'deathEvidence',
        'unreconciled'
      ].sort()
    )
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      Object.assign(persisted.records['session-alpha'], { futureConversationField: 'retained' })
      Object.assign(persisted.records['session-alpha'].lease, {
        minimumNextFence: null,
        futureAuthorityField: 'private'
      })
    })
    const store = await open()
    expect(store.getConversation('session-alpha')?.neverStarted).toBe(false)
    expect(store.getConversation('session-alpha')).toHaveProperty(
      'futureConversationField',
      'retained'
    )
    expect(store.getConversation('session-alpha')?.ownerObservation).toEqual({
      ...healthyOwner,
      unreconciled: true
    })
    expectTypeOf<AgentSessionConversationView>().not.toExtend<AgentSessionRecord>()
    expectTypeOf<AgentSessionConversationView['ownerObservation']>().not.toExtend<
      Parameters<typeof nextAgentSessionFence>[0]
    >()
  })

  it.each([9, 'bad'])(
    'reopens the same saved journal for floor %j and proves automatic receipt admission independently of pauses',
    async (minimumNextFence) => {
      const first = await open()
      await establishOwner(first)
      const logger = recordingStructuredAgentSessionLogger().logger
      const original = await openStructuredAgentSessionConversationJournal(
        {
          store: first,
          journalDatabase: openTestJournalHostDatabase(directory),
          logger
        },
        first.getConversation('session-alpha')!
      )
      await original.session.journal.appendSubmission({
        clientMessageId: operationId(),
        origin: 'client',
        payloadFingerprint: 'saved',
        body: hostTestMessage('saved question'),
        fence: 1,
        handoverRecorded: true
      })
      const savedCard = {
        messageId: 'kept-card',
        fingerprint: 'card',
        body: hostTestMessage('waiting message'),
        hostInstance: 'earlier-runtime'
      }
      await original.session.journal.queuedMessages.insert(savedCard)
      await original.session.journal.close()
      await editPersistedTestAgentSessionStore(directory, (persisted) => {
        Object.assign(persisted.records['session-alpha'].lease, { minimumNextFence })
        const owner = persisted.records['session-alpha'].lease.ownerProcess
        if (owner) {
          owner.runtime = 'previous-runtime'
        }
      })
      const store = await open()
      const record = store.getConversation('session-alpha')!
      const reopened = await openStructuredAgentSessionConversationJournal(
        {
          store,
          journalDatabase: openTestJournalHostDatabase(directory),
          logger
        },
        record
      )
      const journal = reopened.session.journal
      try {
        const history = readStructuredAgentSessionHistoryResult({
          journal,
          record,
          request: { sessionId: 'session-alpha', direction: 'tail' }
        })
        expect(history.page.fence).toBe(1)
        expect(history.providerSession).toMatchObject({ id: 'provider-session-1' })
        expect(journal.submissions()).toMatchObject([{ dispatchState: 'rejected' }])
        expect(store.replacedRuntime('session-alpha')).toMatchObject({ fence: 1 })
        expect(record.ownerObservation.deathEvidence).toBeNull()
        const subscriber = new AgentSessionSubscribers()
        const frames: unknown[] = []
        const unsubscribe = subscriber.open({
          id: 'saved-view',
          sessionId: 'session-alpha',
          journal,
          fence: record.currentFence,
          emit: (frame) => frames.push(frame)
        })
        expect(frames).toMatchObject([{ type: 'snapshot', page: { fence: 1 } }])
        unsubscribe()
        // Lift the old-card pause so strict record validity is the only admission difference.
        await journal.appendQueueResume(1)
        const work = heldStructuredAgentSessionCurrentWork(
          store,
          'session-alpha',
          journal,
          reopened.session
        )
        expect(work.working()).toBe(false)
        const card = journal.queuedMessages.list().find((row) => row.state === 'waiting')
        if (!card) {
          throw new Error('Expected a preserved waiting card')
        }
        const next = nextStructuredQueuedMessage({
          journal,
          work,
          record: store.getRecord('session-alpha')
        })
        expect(next?.messageId ?? null).toBe(minimumNextFence === 'bad' ? null : card.messageId)
        // Direct receipt admission: publication is not authoritative proof.

        const consume = {
          messageId: card.messageId,
          expect: 'waiting' as const,
          settledByOp: null,
          hostInstance: 'current-runtime',
          yieldsToPause: true as const
        }
        const fresh = journal.appendSubmission(
          {
            clientMessageId: operationId(),
            origin: 'host',
            payloadFingerprint: card.fingerprint,
            body: card.body,
            fence: 1,
            handoverRecorded: true
          },
          consume,
          store.submissionReceipt('session-alpha')
        )
        if (minimumNextFence === 'bad') {
          await expect(fresh).rejects.toMatchObject({
            refusal: { details: { reason: 'recordUnreadable' } }
          })
          expect(journal.queuedMessages.get(card.messageId)?.state).toBe('waiting')
          expect(journal.submissions()).toHaveLength(1)
        } else {
          await fresh
          expect(journal.queuedMessages.get(card.messageId)?.state).toBe('dispatched')
          expect(journal.submissions()).toHaveLength(2)
        }
      } finally {
        await journal.close()
      }
    }
  )
})
