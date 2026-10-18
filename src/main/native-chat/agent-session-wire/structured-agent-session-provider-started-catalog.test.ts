// A chat that proves its start shows its account can start one, so the model catalog's held
// "can't start" reason is made due for the probe instead of trusted until its TTL runs out.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { NativeChatSubagentBlock } from '../../../shared/native-chat-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { JournalLifecycleBatchAppender } from '../agent-session-journal/journal-lifecycle-batch-appender'
import {
  subagentJournalBody,
  subagentJournalItemIdentity
} from '../agent-session-journal/journal-subagent-item'
import { loadTestJournal } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredSessionObservationClock } from './structured-agent-session-observation-clock.test-fixture'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
const providerStarted = vi.fn()

function startHost(now = () => NOW): void {
  const acquire: StructuredAgentSessionAdapter['acquire'] = async ({ fence, spawnToken }) => ({
    providerChildPhase: 'starting' as const,
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: codexProviderHandle(THREAD),
      origin: 'created' as const,
      mintedAtFence: fence,
      observedAt: NOW
    },
    acquisitionGeneration: 'generation-1'
  })
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      closeSession: vi.fn(async () => true),
      dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    modelCatalog: {
      read: vi.fn(),
      retainedLiveModelIds: vi.fn(() => []),
      recordLiveListing: vi.fn(),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-started-catalog-'))
  resetHostTestOperationIds()
  providerStarted.mockReset()
  store = await openTestAgentSessionRecordStore(root)
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

/** The adapter's report that the child's protocol session exists. */
function proveStart(): Promise<void> {
  return host.handleAdapterEvent({
    type: 'started',
    sessionId: SESSION,
    fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    acquisitionGeneration: 'generation-1',
    reportedOptions: { model: 'sonnet' }
  })
}

it('a published child tells the catalog only once its start is proven, with its record', async () => {
  startHost()
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({ ok: true })
  expect(providerStarted).not.toHaveBeenCalled()
  await proveStart()
  expect(providerStarted).toHaveBeenCalledTimes(1)
  expect(providerStarted.mock.calls[0]?.[0]).toMatchObject({ sessionId: SESSION })
})

it('a re-attach to the live child proves nothing new and tells the catalog nothing', async () => {
  startHost()
  const params = hostTestAttachParams(null)
  await expect(host.attach(CALLER, params)).resolves.toMatchObject({ ok: true })
  await proveStart()
  const fence = store.getRecord(SESSION)?.lease.runtimeFence
  // A reconnecting client replays its attach; the same operation re-attaches the live child.
  await expect(host.attach(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
  expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(fence)
  expect(providerStarted).toHaveBeenCalledTimes(1)
})

it('publishes an unobserved child while cleanup is refused, then saves the same verdict', async () => {
  const clock = createStructuredSessionObservationClock(() => host, SESSION)
  clock.start()
  try {
    let now = NOW
    startHost(() => now)
    const params = hostTestAttachParams(null)
    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
    await proveStart()
    const rig = host.collaboratorsForTests()
    const journal = rig.sessions.get(SESSION)!.journal
    const sink = rig.runtimeState.currentEventSink(SESSION)!.sink
    const turn = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-f5', ordinal: 1 }
    const child = subagentJournalItemIdentity('child-f5')
    const block: NativeChatSubagentBlock = {
      type: 'subagent',
      id: 'child-f5',
      label: 'Background work',
      groupId: agentJournalItemKey(turn),
      state: 'working',
      background: true
    }
    const options = { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    sink.appendItem(child, subagentJournalBody(block), { ...options, executes: true })
    sink.appendItem(turn, { kind: 'turn', turnId: 'turn-f5', state: 'completed' }, options)
    for (const [ordinal, agentId] of [undefined, block.id].entries()) {
      sink.appendItem(
        { ...turn, ordinal: ordinal + 3 },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Work finished' }]
        },
        { ...options, agentId }
      )
    }
    await host.flushStreamedEvents(SESSION)
    const fence = store.getRecord(SESSION)!.lease.runtimeFence
    const itemId = agentJournalItemKey(child)
    const original = journal.item(itemId)!
    const corrected = {
      ...original,
      body: subagentJournalBody({ ...block, state: 'unverifiable' })
    }
    const frames: AgentSessionSubscribeEvent[] = []
    await host.subscribe({
      id: 'f5-reader',
      sessionId: SESSION,
      emit: (frame) => frames.push(frame)
    })
    const cleanup = vi
      .spyOn(JournalLifecycleBatchAppender.prototype, 'appendPlanned')
      .mockRejectedValue(new Error('F5 cleanup refused'))
    vi.mocked(host.deps.adapter.releaseAcquisition!).mockResolvedValue(false)
    const database = openTestJournalHostDatabase(root)
    const outcome = store.recordOperationOutcome.bind(store)
    const recording = vi
      .spyOn(store, 'recordOperationOutcome')
      .mockImplementationOnce(async (...args) => {
        expect(rig.sessions.get(SESSION)?.child?.fence).toBe(fence)
        const transaction = vi.spyOn(database, 'transaction').mockImplementationOnce(() => {
          throw new Error('F5 outcome transaction refused')
        })
        try {
          return await outcome(...args)
        } finally {
          transaction.mockRestore()
        }
      })
    await expect(host.attach(CALLER, params)).rejects.toThrow('post-acquisition attachment failure')
    recording.mockRestore()
    expect(frames.findLast((frame) => frame.type === 'snapshot')).toMatchObject({
      type: 'snapshot',
      page: { items: expect.arrayContaining([corrected]) }
    })
    const capture = async () => {
      const page = await host.history({ sessionId: SESSION, direction: 'tail' })
      expect(page.page.items).toContainEqual(corrected)
      const tail = await host.history({ sessionId: SESSION, direction: 'tail', limit: 1 })
      expect(tail.page.items.some((item) => item.itemId === itemId)).toBe(false)
      expect(tail.page.subagentRoster).toMatchObject([{ entry: { state: 'unverifiable' } }])
      const saved = loadTestJournal(root, SESSION)!
      expect(saved.state.items.get(itemId)?.body).toEqual(original.body)
    }
    now += 31 * 60_000
    await rig.lifetime.idleSweep.tick()
    expect(rig.sessions.has(SESSION)).toBe(false)
    await capture()
    await clock.observe(5_000)
    await capture()
    cleanup.mockRestore()
    await clock.observe(5_000)
    expect(loadTestJournal(root, SESSION)!.state.items.get(itemId)?.body).toEqual(corrected.body)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      runtimeFence: fence
    })
    expect(
      store.getOperationRow(CALLER.callerKey, params.envelope.clientOperationId)?.outcome.status
    ).toBe('succeeded')
  } finally {
    vi.restoreAllMocks()
    clock.restore()
  }
})
