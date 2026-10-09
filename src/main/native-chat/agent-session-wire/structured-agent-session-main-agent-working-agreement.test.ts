// The chat's own Stop and every session list read whether the main agent is working through one
// rule, but over two copies of the host's journal: the chat reduces its stream, and a list reads the
// status feed. Both leave the host from one publication edge, so once each has landed they must say
// the same thing. Against the real host, store, journal, stream and status feed.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { startsWhenPublished } from './structured-agent-session-instant-start.test-support'

const CALLER = { callerKey: 'client-1' }
const PROVIDER_ROW = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let events: StructuredAgentSessionEventSink | undefined
/** The session's child records, as the host's store serves them to every surface. */
let records: AgentChildWorkView[]
let chat: StructuredAgentSessionState
let listed: AgentSessionStatusSummary | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-main-agent-working-'))
  resetHostTestOperationIds()
  events = undefined
  records = []
  chat = EMPTY_STRUCTURED_AGENT_SESSION
  listed = undefined
  // Written, and the provider has neither opened a turn for it nor answered it.
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: startsWhenPublished(
      {
        acquire: async (input) => {
          events = input.events
          return {
            process: {
              hostId: 'local',
              pid: 4242,
              processStartTimeMs: 1_700_000_000_000,
              spawnToken: input.spawnToken
            },
            acquisitionGeneration: 'generation-1',
            link: {
              linkId: `link-${input.fence}`,
              handle: codexProviderHandle(THREAD),
              origin: 'created' as const,
              mintedAtFence: input.fence,
              observedAt: NOW
            }
          }
        },
        dispatch,
        closeSession: vi.fn(async () => true),
        releaseAcquisition: vi.fn(async () => true),
        cancelTurn: vi.fn(async () => ({ cancelled: true })),
        answerPrompt: vi.fn(async () => undefined),
        setOption: vi.fn(async () => undefined)
      },
      () => host
    ),
    statusSink: { publish: () => {}, forget: () => {}, readChildWork: () => records },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  host.subscribe({
    id: 'chat-1',
    sessionId: SESSION,
    emit: (event) => {
      chat = reduceStructuredAgentSession(chat, { type: 'event', event: structuredClone(event) })
    }
  })
  host.subscribeStatus({
    id: 'list-1',
    emit: (event) => {
      if (event.type === 'status' && event.session.sessionId === SESSION) {
        listed = structuredClone(event.session)
      } else if (event.type === 'snapshot') {
        listed = event.sessions.find((session) => session.sessionId === SESSION) ?? listed
      }
    }
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const clientOperationId = hostTestOperationId()
  expect(
    await host.send(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId,
        expectedRuntimeFence: 1,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body }
        })
      },
      body
    })
  ).toMatchObject({ ok: true })
  return clientOperationId
}

async function provider(ordinal: number, body: AgentJournalItemBody): Promise<void> {
  events!.appendItem({ ...PROVIDER_ROW, ordinal }, body, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  events!.publish()
  await host.flushStreamedEvents(SESSION)
}

/** What the chat's Stop reads: the transport state's rule over the chat's reduced stream. */
function chatReadsWorking(): boolean {
  return isStructuredAgentSessionMainAgentWorking(
    activeStructuredAgentSessionTurnId(chat.items),
    chat.submissions,
    chat.fence
  )
}

/** What a session list's row reads for the main agent, and the whole row, from the status feed. */
function listReads(): { mainAgent: string; row: string } {
  const summary = listed
  if (!summary?.status) {
    return { mainAgent: 'none', row: 'none' }
  }
  const status = structuredAgentSessionAgentStatus({
    ...summary,
    status: summary.status,
    childWork: summary.children
  })
  return { mainAgent: status.mainAgent.state, row: status.state }
}

describe('the main agent read by the chat and by a session list', () => {
  it('agrees while a rate-limited request retries with no turn open', async () => {
    const id = await send('hello')
    await vi.waitFor(async () =>
      expect((await host.journalSnapshot(SESSION)).submissions[0]?.handedOverAt).toBeDefined()
    )
    // What Claude writes for an HTTP 429 retry: a status row, no echo, no turn.
    await provider(1, { kind: 'status', text: 'rate_limit', tone: 'error' })
    await provider(2, { kind: 'status', text: 'rate_limit', tone: 'error' })

    expect(chat.submissions.map((submission) => submission.clientMessageId)).toEqual([id])
    expect(activeStructuredAgentSessionTurnId(chat.items)).toBeNull()
    expect(chatReadsWorking()).toBe(true)
    expect(listReads().mainAgent).toBe('working')
  })

  it('agrees once the handed-over message is answered and only a subagent still runs', async () => {
    dispatch.mockResolvedValueOnce({
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 }
    })
    await send('fan out')
    await vi.waitFor(async () =>
      expect((await host.journalSnapshot(SESSION)).submissions[0]?.dispatchState).toBe('accepted')
    )
    await provider(1, { kind: 'turn', turnId: 'turn-1', state: 'running' })
    expect(chatReadsWorking()).toBe(true)
    expect(listReads().mainAgent).toBe('working')

    await provider(1, { kind: 'turn', turnId: 'turn-1', state: 'completed', outcome: 'success' })
    records = [
      {
        id: 'child-1',
        providerId: 'task-1',
        kind: 'agent',
        name: 'deep_review',
        state: 'working',
        membership: 'live',
        firstObservedAt: NOW,
        observedAt: NOW,
        stoppable: false,
        invocation: { invocationId: 'task-1', generation: 1 }
      }
    ]
    host.publishChildWorkEvidence(SESSION, [])
    await host.flushStreamedEvents(SESSION)

    expect(chat.backgroundTasks?.children).toHaveLength(1)
    // The row reads Working for the subagent; the main agent, and so Stop, does not.
    expect(listReads()).toEqual({ mainAgent: 'done', row: 'working' })
    expect(chatReadsWorking()).toBe(false)
  })

  it('agrees when the child that was handed the message exits', async () => {
    await send('hello')
    await vi.waitFor(async () =>
      expect((await host.journalSnapshot(SESSION)).submissions[0]?.handedOverAt).toBeDefined()
    )
    expect(chatReadsWorking()).toBe(true)

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: 'generation-1',
      reason: 'codex app-server crashed',
      cause: 'unexpected-exit'
    })
    await host.flushStreamedEvents(SESSION)

    expect(chat.fence).toBe(store.getRecord(SESSION)!.lease.runtimeFence)
    expect(chatReadsWorking()).toBe(false)
    expect(listReads().mainAgent).not.toBe('working')
  })
})
