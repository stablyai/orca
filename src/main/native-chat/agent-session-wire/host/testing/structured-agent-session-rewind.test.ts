import { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { recoverStructuredRewind } from '../../rewind/structured-rewind-recovery'
import { persistRewindRecord } from '../../rewind/structured-rewind-record'
import {
  projectForkMarker,
  readForkMarker
} from '../../publication/history/agent-session-fork-marker'
import { expectAtomicRewindCompletion } from './structured-agent-session-rewind-replay.test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { expectUsageLimitCompletionRollback } from './structured-agent-session-rewind-usage-limit.test-fixture'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionAcquireInput,
  AgentSessionDispatchOutcome
} from '../../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../../journal-ingress/structured-agent-session-event-sink'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../structured-agent-session-logger'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { claudeAndCodexDeclared } from '../../providers/testing/structured-agent-session-adapter-router-test-support'
import { startsWhenPublished } from './structured-agent-session-instant-start.test-support'

const caller = { callerKey: 'desktop' }
let clock = HOST_TEST_NOW
let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let sink: StructuredAgentSessionEventSink
let adapter: StructuredAgentSessionAdapter
let acquires: StructuredAgentSessionAcquireInput[]
const rewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['rewind']>>()
const recoverRewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>>()

beforeEach(async () => {
  clock = HOST_TEST_NOW
  resetHostTestOperationIds()
  rewind.mockReset().mockResolvedValue({ ok: true })
  recoverRewind.mockReset().mockResolvedValue({ ok: true })
  acquires = []
  directory = await mkdtemp(join(tmpdir(), 'orca-rewind-'))
  store = await openTestAgentSessionRecordStore(directory)
  adapter = startsWhenPublished(
    {
      supportsCreate: (_location, agent) => agent === 'codex',
      supportsLocation: () => true,
      open: async () => ({
        reportedOptions: { model: '' }
      }),
      acquire: async (input) => {
        acquires.push(input)
        sink = input.events!
        return {
          process: {
            hostId: 'local',
            pid: 4000 + acquires.length,
            processStartTimeMs: HOST_TEST_NOW,
            spawnToken: input.spawnToken
          },
          acquisitionGeneration: `generation-${acquires.length}`,
          link: {
            linkId: `link-${acquires.length}`,
            mintedAtFence: input.fence,
            observedAt: HOST_TEST_NOW,
            origin: acquires.length === 1 ? 'created' : 'resumed',
            handle: codexProviderHandle(HOST_TEST_THREAD)
          }
        }
      },
      dispatch: vi.fn(async (): Promise<AgentSessionDispatchOutcome> => ({
        state: 'unknown',
        reason: 'test'
      })),
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => {},
      setOption: async () => {},
      rewindSupport: () => ({ supported: true }),
      prepareRewind: async (input) => ({
        ok: true,
        revert: {
          threadId: HOST_TEST_THREAD,
          beforeTurnId: input.beforeTurnId,
          keptTurnId: input.beforeTurnId === 'drop' ? 'kept' : null
        }
      }),
      rewind,
      recoverRewind,
      releaseAcquisition: async () => true,
      closeSession: async () => true
    },
    () => host
  )
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    now: () => clock,
    probeOwner: async () => ({ outcome: 'exit-observed' })
  })
})
afterEach(async () => {
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

/** Await startup reconciliation; unresolved rewind fails startup in its own stop step. */
async function attachAndStart(fence: number | null) {
  const attached = await host.attach(caller, hostTestAttachParams(fence))
  const { serialize } = host.collaboratorsForTests()
  await serialize(HOST_TEST_SESSION, async () => {})
  await serialize(HOST_TEST_SESSION, async () => {})
  return attached
}

async function seed(acceptedSubmissions = false) {
  expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const keys = ['kept', 'drop', 'tip'].map((turnId) => ({
    provider: 'codex' as const,
    threadId: HOST_TEST_THREAD,
    turnId,
    ordinal: 0
  }))
  let selectedItemId = agentJournalItemKey(keys[1]!)
  for (const [i, identity] of keys.entries()) {
    const body = {
      ...hostTestMessage(String(i)),
      role: i === 2 ? ('assistant' as const) : ('user' as const)
    }
    if (acceptedSubmissions && i !== 2) {
      const clientOperationId = hostTestOperationId()
      vi.mocked(adapter.dispatch).mockResolvedValueOnce({
        state: 'accepted',
        providerIdentity: identity
      })
      expect(
        await host.send(caller, {
          body,
          envelope: {
            sessionId: HOST_TEST_SESSION,
            clientOperationId,
            expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.send',
              sessionId: HOST_TEST_SESSION,
              fields: { body }
            })
          }
        })
      ).toMatchObject({ ok: true })
      await vi.waitFor(async () =>
        expect(
          (await host.journalSnapshot(HOST_TEST_SESSION)).submissions.find(
            (entry) => entry.clientMessageId === clientOperationId
          )?.dispatchState
        ).toBe('accepted')
      )
      if (i === 1) {
        selectedItemId = agentJournalSubmissionKey(clientOperationId)
      }
    } else {
      sink.appendItem(identity, body, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    }
  }
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  return selectedItemId
}
async function params(itemId: string, epoch?: string) {
  const expectedEpoch = epoch ?? (await host.journalSnapshot(HOST_TEST_SESSION)).cursor.epoch
  return {
    itemId,
    expectedEpoch,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId: HOST_TEST_SESSION,
        fields: { itemId, expectedEpoch }
      })
    }
  }
}

describe('host rewind', () => {
  it('commits context and completion atomically before a post-commit crash', async () => {
    await expectAtomicRewindCompletion({ host, store, seed, params, attachAndStart })
  })

  it('rolls back a failed logical rewind completion and recovers usage-limit cancellation once', async () => {
    ;({ host, store } = await expectUsageLimitCompletionRollback({
      host,
      store,
      seed,
      params,
      attachAndStart,
      directory,
      rewind,
      now: () => clock,
      advanceClock: () => {
        clock += 75_000
      }
    }))
  })
})

it('persists the live native predecessor before revert and retains it after a lost reply', async () => {
  const target = await seed()
  rewind.mockImplementationOnce(async () => {
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind).toMatchObject({
      phase: 'prepared',
      providerRevert: { threadId: HOST_TEST_THREAD, beforeTurnId: 'drop', keptTurnId: 'kept' }
    })
    throw new Error('reply lost')
  })
  await expect(host.rewind(caller, await params(target))).rejects.toThrow('reply lost')
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.providerRevert).toEqual({
    threadId: HOST_TEST_THREAD,
    beforeTurnId: 'drop',
    keptTurnId: 'kept'
  })
})

it('refuses inherited rewind and rewinds the first own prompt to the fork point', async () => {
  const inherited = await seed()
  const ancestry = {
    sessionId: 'original-chat',
    itemId: 'codex:original-thread:tip:0',
    childBoundary: {
      kind: 'item' as const,
      itemId: agentJournalItemKey({
        provider: 'codex',
        threadId: HOST_TEST_THREAD,
        turnId: 'tip',
        ordinal: 0
      })
    }
  }
  await store.commitOperationReceipt(
    store.conversationReceipts.forkBoundary(HOST_TEST_SESSION, ancestry)
  )
  expect(await host.rewind(caller, await params(inherited))).toMatchObject({
    ok: false,
    refusal: {
      code: 'agent_session_operation_invalid',
      details: { rewindReason: 'invalid-target' }
    }
  })
  sink.appendItem(
    { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'own', ordinal: 0 },
    { ...hostTestMessage('first own prompt'), role: 'user' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  adapter.prepareRewind = async () => ({
    ok: true,
    revert: { threadId: HOST_TEST_THREAD, beforeTurnId: 'own', keptTurnId: 'tip' }
  })
  const own = agentJournalItemKey({
    provider: 'codex',
    threadId: HOST_TEST_THREAD,
    turnId: 'own',
    ordinal: 0
  })
  expect(await host.rewind(caller, await params(own))).toMatchObject({ ok: true })
  expect(store.getRecord(HOST_TEST_SESSION)?.forkedFrom).toEqual(ancestry)
  expect(
    (await host.journalSnapshot(HOST_TEST_SESSION)).items
      .filter((item) => item.body.kind === 'message')
      .map((item) => item.body.kind === 'message' && item.body.blocks)
  ).toEqual([
    [{ type: 'text', text: '0' }],
    [{ type: 'text', text: '1' }],
    [{ type: 'text', text: '2' }]
  ])
})

it('completes an inherited rewind saved by the PR1 build with an atomic surviving divider after restart', async () => {
  const target = await seed()
  const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
  const journal = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  await store.commitOperationReceipt(
    store.conversationReceipts.forkBoundary(HOST_TEST_SESSION, {
      sessionId: 'original-chat',
      itemId: 'codex:original-thread:tip:0',
      childBoundary: { kind: 'item', itemId: 'codex:019fd532-7c11-7a90-b6de-4e1a2c3d5f60:tip:0' }
    })
  )
  await persistRewindRecord(store, HOST_TEST_SESSION, fence, {
    operationId: hostTestOperationId(),
    callerKey: 'desktop',
    itemId: target,
    expectedEpoch: journal.epoch,
    phase: 'provider-succeeded',
    providerRevert: {
      threadId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f60',
      beforeTurnId: 'drop',
      keptTurnId: 'kept'
    }
  })
  await journal.close()
  store = await openTestAgentSessionRecordStore(directory)
  const reopened = new AgentSessionJournal({
    identity: {
      sessionId: HOST_TEST_SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('019fd532-7c11-7a90-b6de-4e1a2c3d5f60')
    },
    database: openTestJournalHostDatabase(directory)
  })
  await reopened.open()
  const replace = reopened.replaceEpochItems.bind(reopened)
  vi.spyOn(reopened, 'replaceEpochItems').mockImplementationOnce(async (...args) => {
    await replace(...args)
    throw new Error('crash after atomic completion')
  })
  await expect(
    recoverStructuredRewind(
      { store, logger: createStructuredAgentSessionLogger() },
      HOST_TEST_SESSION,
      reopened,
      fence
    )
  ).rejects.toThrow('crash after atomic completion')
  await reopened.close()
  store = await openTestAgentSessionRecordStore(directory)
  await reopened.open()
  await recoverStructuredRewind(
    { store, logger: createStructuredAgentSessionLogger() },
    HOST_TEST_SESSION,
    reopened,
    fence
  )
  expect(store.getRecord(HOST_TEST_SESSION)?.forkedFrom?.childBoundary).toEqual({
    kind: 'item',
    itemId: 'codex:019fd532-7c11-7a90-b6de-4e1a2c3d5f60:kept:0'
  })
  expect(
    projectForkMarker(reopened.snapshot(), readForkMarker(store, HOST_TEST_SESSION)).items.map(
      (item) => item.itemId
    )
  ).toEqual(['codex:019fd532-7c11-7a90-b6de-4e1a2c3d5f60:kept:0', 'orca:forked-from'])
  await reopened.close()
})
