import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// What an open chat receives, asserted at its subscriber rather than in the journal: a fresh
// subscribe re-reads the journal and hides a write that never reached the readers already open.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
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

const CALLER = { callerKey: 'client-1' }
const EXIT_REASON = 'Claude Code is not signed in. Sign in with the Claude CLI'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let generation = 0

/** Everything a live subscriber was sent after it opened. */
function liveReader() {
  const events: AgentSessionSubscribeEvent[] = []
  host.subscribe({ id: 'pane', sessionId: SESSION, emit: (event) => events.push(event) })
  const opened = events.length
  const received = () => {
    const items: AgentJournalRenderItem[] = []
    const submissions: AgentJournalSubmission[] = []
    for (const event of events.slice(opened)) {
      if (event.type === 'batch') {
        items.push(...event.batch.items)
        submissions.push(...event.batch.submissions)
      } else if (event.type === 'snapshot' || event.type === 'reset') {
        items.push(...event.page.items)
        submissions.push(...event.page.submissions)
      }
    }
    return {
      statuses: items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : [])),
      submissions,
      batches: events.slice(opened).filter((event) => event.type === 'batch').length
    }
  }
  return { received }
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true })
  return sent.ok ? sent.value.clientMessageId : ''
}

function exitBeforeProof(): Promise<void> {
  return host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    acquisitionGeneration: `generation-${generation}`,
    reason: EXIT_REASON,
    cause: 'unexpected-exit',
    startupUnproven: true
  })
}

function providerSink() {
  const events = acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('no acquired provider sink')
  }
  return events
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-append-delivery-'))
  resetHostTestOperationIds()
  generation = 0
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: generation === 0 ? ('created' as const) : ('resumed' as const),
      mintedAtFence: fence,
      observedAt: NOW
    },
    acquisitionGeneration: `generation-${++generation}`,
    providerChildPhase: 'starting' as const
  }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
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
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${generation + 1}`,
    now: () => NOW
  })
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({
    ok: true
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('an open chat receives every row its journal commits', () => {
  it('shows a failed start whose lease could not be handed back', async () => {
    const held = await send('hello')
    const pane = liveReader()
    // The exit settles the journal, then fails to release the lease: nothing moves the fence.
    vi.spyOn(store, 'transitionHandoff').mockRejectedValueOnce(new Error('record store busy'))

    await exitBeforeProof()

    // The exit ends the child; the delivery loop, which reads why, rejects what it had queued.
    await vi.waitFor(() =>
      expect(pane.received().submissions).toContainEqual(
        expect.objectContaining({ clientMessageId: held, dispatchState: 'rejected' })
      )
    )
    // One row, however many of its writers reported the start.
    expect(new Set(pane.received().statuses)).toEqual(
      new Set([expect.stringMatching(/stopped before it finished starting: .*not signed in/)])
    )
  })

  it('shows a revision the provider queued with no publish behind it', async () => {
    const pane = liveReader()
    const identity = { provider: 'orca' as const, clientMessageId: 'context-usage' }
    const body = { kind: 'status' as const, text: 'context usage answered after the turn' }

    expect(
      providerSink().tryReviseResolvedItem?.(4_096, () => ({ identity, body }), {
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    ).toEqual({
      accepted: true
    })
    await host.flushStreamedEvents(SESSION)

    expect(pane.received().statuses).toEqual(['context usage answered after the turn'])
  })

  it('shows a row appended straight to the journal', async () => {
    const pane = liveReader()
    const journal = host['sessions'].get(SESSION)?.journal
    if (!journal) {
      throw new Error('the attached chat has no journal')
    }

    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'host-note' },
      { kind: 'status', text: 'written by a writer that publishes nothing' },
      {
        fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )

    expect(pane.received().statuses).toEqual(['written by a writer that publishes nothing'])
  })
})

describe('an open chat receives each row once', () => {
  it('when the provider frame that wrote it also publishes', async () => {
    const pane = liveReader()
    const sink = providerSink()
    const journal = host['sessions'].get(SESSION)?.journal
    if (!journal) {
      throw new Error('the attached chat has no journal')
    }
    const readSince = vi.spyOn(journal, 'readSince')

    sink.appendItem(
      { provider: 'orca', clientMessageId: 'streamed' },
      { kind: 'status', text: 'streamed row' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    sink.publish()
    await host.flushStreamedEvents(SESSION)

    expect(pane.received().statuses).toEqual(['streamed row'])
    // The frame's publish finds the reader caught up and reads no rows: streaming stays one read.
    expect(readSince).toHaveBeenCalledOnce()
  })

  it('when a writer publishes the row it appended', async () => {
    const pane = liveReader()
    const journal = host['sessions'].get(SESSION)?.journal
    if (!journal) {
      throw new Error('the attached chat has no journal')
    }

    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'host-row' },
      { kind: 'status', text: 'host row' },
      {
        fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )
    host['subscribers'].publish(SESSION, journal)

    expect(pane.received().statuses).toEqual(['host row'])
    // The second publish found nothing past the reader's cursor, so it sent nothing at all.
    expect(pane.received().batches).toBe(1)
  })
})
