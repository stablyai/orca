import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRewindFork } from '../../../shared/agent-session-rewind'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { startsWhenPublished } from './structured-agent-session-instant-start.test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { recoverStructuredRewind } from './structured-rewind-recovery'

const caller = { callerKey: 'desktop' }
const SOURCE = '11111111-1111-4111-8111-111111111111'
const FORK: AgentSessionRewindFork = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  sourceSessionId: SOURCE,
  replacesSessionId: SOURCE,
  materialized: true,
  resumeCursor: 'fork-answer-1'
}
const key = (uuid: string) => agentJournalItemKey({ provider: 'claude', sessionId: SOURCE, uuid })
let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let sink: StructuredAgentSessionEventSink
let failAcquire: boolean
const forkForRewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['forkForRewind']>>(
  async () => ({ ok: true, fork: FORK })
)
const closeSession = vi.fn(async () => true)

const attachParams = (fence: number | null) =>
  hostTestAttachParams(fence, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    providerHandle: { kind: 'claude', sessionId: SOURCE, leafUuid: 'answer-2' }
  })

beforeEach(async () => {
  resetHostTestOperationIds()
  failAcquire = false
  forkForRewind.mockReset()
  closeSession.mockClear()
  forkForRewind.mockImplementation(async ({ record, beforeMessage }) => ({
    ok: true,
    fork: {
      ...FORK,
      sessionId:
        beforeMessage.uuid === 'prompt-2' ? FORK.sessionId : '33333333-3333-4333-8333-333333333333',
      ...(beforeMessage.uuid === 'prompt-1' ? { resumeCursor: undefined } : {}),
      replacesSessionId: agentSessionProviderHandleChainHead(record.providerHandleChain)!.handle
        .nativeId
    }
  }))
  directory = await mkdtemp(join(tmpdir(), 'orca-fork-rewind-'))
  store = await openTestAgentSessionRecordStore(directory)
  const adapter = startsWhenPublished(
    {
      supportsCreate: (_location, agent) => agent === 'claude',
      supportsLocation: () => true,
      acquire: async (input) => {
        if (failAcquire) {
          throw new Error('Claude cannot start')
        }
        sink = input.events!
        return {
          providerChildPhase: 'starting' as const,
          process: {
            hostId: 'local',
            pid: 5001,
            processStartTimeMs: HOST_TEST_NOW,
            spawnToken: input.spawnToken
          },
          acquisitionGeneration: 'generation-1',
          link: {
            linkId: 'link-1',
            mintedAtFence: input.fence,
            observedAt: HOST_TEST_NOW,
            origin: 'created',
            handle: claudeProviderHandle(SOURCE, 'answer-2')
          }
        }
      },
      dispatch: async () => ({ state: 'unknown', reason: 'test' }),
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => {},
      setOption: async () => {},
      rewindSupport: () => ({ supported: true }),
      forkForRewind,
      releaseAcquisition: async () => true,
      closeSession
    },
    () => host
  )
  const agents = claudeAndCodexAgents({ claude: adapter, codex: adapter })
  host = new StructuredAgentSessionHost({
    agents,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    probeOwner: async () => ({ outcome: 'exit-observed' })
  })
  expect(await host.attach(caller, attachParams(null))).toMatchObject({ ok: true })
  for (const [uuid, role] of [
    ['prompt-1', 'user'],
    ['answer-1', 'assistant'],
    ['prompt-2', 'user'],
    ['answer-2', 'assistant']
  ] as const) {
    sink.appendItem(
      { provider: 'claude', sessionId: SOURCE, uuid },
      { ...hostTestMessage(uuid), role },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await host.flushStreamedEvents(HOST_TEST_SESSION)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await host.flushAllStreamedEvents()
  await rm(directory, { recursive: true, force: true })
})

async function rewindSecondPrompt() {
  const fields = {
    itemId: key('prompt-2'),
    expectedEpoch: (await host.journalSnapshot(HOST_TEST_SESSION)).cursor.epoch
  }
  return host.rewind(caller, {
    ...fields,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId: HOST_TEST_SESSION,
        fields
      })
    }
  })
}

describe('rewinding a chat whose agent forks', () => {
  it('commits the fork head with the prefix and rewinds again at rest without starting the agent', async () => {
    const epoch = (await host.journalSnapshot(HOST_TEST_SESSION)).cursor.epoch
    const fields = { itemId: key('prompt-2'), expectedEpoch: epoch }
    const envelope = {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId: HOST_TEST_SESSION,
        fields
      })
    }

    expect(await host.rewind(caller, { ...fields, envelope })).toMatchObject({ ok: true })

    expect(forkForRewind).toHaveBeenCalledWith(
      expect.objectContaining({ beforeMessage: { sessionId: SOURCE, uuid: 'prompt-2' } })
    )
    expect(closeSession).toHaveBeenCalled()
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind).toMatchObject({
      phase: 'completed',
      providerFork: { materialized: true }
    })
    const record = store.getRecord(HOST_TEST_SESSION)!
    const fork = record.rewind!.providerFork!
    // Preserve fields read by v1.4.233, which ignores providerFork.
    expect(agentSessionProviderHandleChainHead(record.providerHandleChain)).toMatchObject({
      origin: 'forked',
      handle: claudeProviderHandle(fork.sessionId, 'fork-answer-1')
    })
    const snapshot = await host.journalSnapshot(HOST_TEST_SESSION)
    expect(snapshot.items.map((item) => item.itemId)).toEqual([key('prompt-1'), key('answer-1')])

    failAcquire = true
    const again = { itemId: key('prompt-1'), expectedEpoch: snapshot.cursor.epoch }
    expect(
      await host.rewind(caller, {
        ...again,
        envelope: {
          sessionId: HOST_TEST_SESSION,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.rewind',
            sessionId: HOST_TEST_SESSION,
            fields: again
          })
        }
      })
    ).toMatchObject({ ok: true })
    expect((await host.journalSnapshot(HOST_TEST_SESSION)).items).toEqual([])
    expect(
      agentSessionProviderHandleChainHead(store.getRecord(HOST_TEST_SESSION)!.providerHandleChain)
        ?.handle
    ).toEqual(claudeProviderHandle('33333333-3333-4333-8333-333333333333', null))
  })

  it('keeps the original conversation when saving its fork fails', async () => {
    const before = await host.journalSnapshot(HOST_TEST_SESSION)
    forkForRewind.mockRejectedValueOnce(new Error('transcript write failed'))
    await expect(rewindSecondPrompt()).rejects.toThrow('transcript write failed')
    expect(await host.journalSnapshot(HOST_TEST_SESSION)).toEqual(before)
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind).toBeUndefined()
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('rolls back both history and handle when the receipt fails, then recovers the same fork', async () => {
    const journal = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
    const before = await host.journalSnapshot(HOST_TEST_SESSION)
    const makeReceipt = store.conversationReceipts.rewind.bind(store.conversationReceipts)
    const failed = vi
      .spyOn(store.conversationReceipts, 'rewind')
      .mockImplementationOnce((...args) => {
        const receipt = makeReceipt(...args)
        return {
          ...receipt,
          write: (db) => {
            receipt.write(db)
            throw new Error('commit failed')
          }
        }
      })
    await expect(rewindSecondPrompt()).rejects.toThrow('commit failed')
    expect(await host.journalSnapshot(HOST_TEST_SESSION)).toEqual(before)
    expect(
      agentSessionProviderHandleChainHead(store.getRecord(HOST_TEST_SESSION)!.providerHandleChain)
        ?.handle.nativeId
    ).toBe(SOURCE)
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('provider-succeeded')
    failed.mockRestore()

    await recoverStructuredRewind(
      { store, logger: createStructuredAgentSessionLogger() },
      HOST_TEST_SESSION,
      journal,
      store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    )
    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
      key('prompt-1'),
      key('answer-1')
    ])
    expect(
      agentSessionProviderHandleChainHead(store.getRecord(HOST_TEST_SESSION)!.providerHandleChain)
        ?.handle.nativeId
    ).toBe(FORK.sessionId)
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('completed')
    expect(forkForRewind).toHaveBeenCalledTimes(1)
  })
})
