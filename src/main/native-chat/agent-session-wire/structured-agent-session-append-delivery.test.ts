import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// Observe existing subscribers: fresh subscribe could hide missed live delivery by rereading the journal.

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
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
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
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }
const EXIT_REASON = 'Claude Code is not signed in. Sign in with the Claude CLI'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let generation = 0

async function liveReader() {
  const events: AgentSessionSubscribeEvent[] = []
  await host.subscribe({ id: 'pane', sessionId: SESSION, emit: (event) => events.push(event) })
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
    const rows = new Map<string, string>()
    for (const item of items) {
      if (item.body.kind === 'status') {
        rows.set(item.itemId, item.body.text)
      }
    }
    return {
      statuses: items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : [])),
      statusRows: [...rows.values()],
      submissions,
      batches: events.slice(opened).filter((event) => event.type === 'batch').length
    }
  }
  const hydration = events.findLast((event) => event.type === 'snapshot' || event.type === 'reset')
  return {
    received,
    hydratedCursor: hydration?.page.liveCursor ?? hydration?.page.window.nextCursor
  }
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
    failure: { kind: 'providerExited', detail: { text: EXIT_REASON, audience: 'log' } },
    cause: 'unexpected-exit'
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
      handle: codexProviderHandle(THREAD),
      origin: generation === 0 ? ('created' as const) : ('resumed' as const),
      mintedAtFence: fence,
      observedAt: NOW
    },
    acquisitionGeneration: `generation-${++generation}`
  }))
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      open: () => new Promise(() => {}),
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      closeSession: vi.fn(async () => true),
      dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
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
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('an open chat receives every row its journal commits', () => {
  it('shows a failed start whose lease could not be handed back', async () => {
    const held = await send('hello')
    const pane = await liveReader()
    // Inject lease-release failure after journal exit settlement without advancing the fence.
    vi.spyOn(store, 'transitionHandoff').mockRejectedValueOnce(new Error('record store busy'))

    await exitBeforeProof()

    await vi.waitFor(() =>
      expect(pane.received().submissions).toContainEqual(
        expect.objectContaining({ clientMessageId: held, dispatchState: 'rejected' })
      )
    )
    expect(pane.received().statusRows).toEqual([
      'Codex stopped before it finished starting. Send your message to try again.'
    ])
  })

  it('shows a revision the provider queued with no publish behind it', async () => {
    const pane = await liveReader()
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
    const pane = await liveReader()
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
    const pane = await liveReader()
    const sink = providerSink()
    const journal = host['sessions'].get(SESSION)?.journal
    if (!journal) {
      throw new Error('the attached chat has no journal')
    }
    const hydratedCursor = journal.cursor()
    expect(pane.hydratedCursor).toEqual(hydratedCursor)
    const reads: {
      epoch: string
      sequence: number
      limit: number | undefined
      ok: boolean
      returnedCursor: { epoch: string; sequence: number } | null
      rowCount: number
      rows: { epoch: string; sequence: number; kind: string; itemId: string | null }[]
    }[] = []
    const realReadSince = journal.readSince.bind(journal)
    const readSince = vi.spyOn(journal, 'readSince').mockImplementation((cursor, limit) => {
      const epoch = cursor.epoch
      const sequence = cursor.sequence
      const result = realReadSince(cursor, limit)
      reads.push({
        epoch,
        sequence,
        limit,
        ok: result.ok,
        returnedCursor: result.ok
          ? { epoch: result.cursor.epoch, sequence: result.cursor.sequence }
          : null,
        rowCount: result.ok ? result.rows.length : 0,
        rows: result.ok
          ? result.rows.map((row) => ({
              epoch: row.epoch,
              sequence: row.seq,
              kind: row.kind,
              itemId: 'itemId' in row ? row.itemId : null
            }))
          : []
      })
      return result
    })

    sink.appendItem(
      { provider: 'orca', clientMessageId: 'streamed' },
      { kind: 'status', text: 'streamed row' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    sink.publish()
    await host.flushStreamedEvents(SESSION)

    expect(pane.received().statuses).toEqual(['streamed row'])
    expect(pane.received().batches).toBe(1)
    const committedCursor = { epoch: hydratedCursor.epoch, sequence: hydratedCursor.sequence + 1 }
    expect(journal.cursor()).toEqual(committedCursor)
    const readResult = {
      epoch: hydratedCursor.epoch,
      sequence: hydratedCursor.sequence,
      ok: true,
      returnedCursor: committedCursor,
      rowCount: 1,
      rows: [
        {
          epoch: committedCursor.epoch,
          sequence: committedCursor.sequence,
          kind: 'item',
          itemId: 'orca:streamed'
        }
      ]
    }
    // Call-time provenance: readForward owns lookahead; reusePromptProjection owns the delta.
    const paneHistoryRead = { ...readResult, limit: 201 }
    const promptDeltaRead = { ...readResult, limit: 200 }
    expect(reads.filter(({ limit }) => limit === paneHistoryRead.limit)).toEqual([paneHistoryRead])
    expect(reads.filter(({ limit }) => limit === promptDeltaRead.limit)).toEqual([promptDeltaRead])
    expect(reads).toHaveLength(2)
    expect(readSince).toHaveBeenCalledTimes(2)
    expect(reads.reduce((count, read) => count + read.rowCount, 0)).toBe(2)

    const delivered = pane.received()
    const settledReads = [...reads]
    sink.publish()
    await host.flushStreamedEvents(SESSION)

    expect(reads).toEqual(settledReads)
    expect(readSince).toHaveBeenCalledTimes(2)
    expect(pane.received()).toEqual(delivered)
  })

  it('when a writer publishes the row it appended', async () => {
    const pane = await liveReader()
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
    expect(pane.received().statuses).toEqual(['host row'])
    const delivered = pane.received().batches
    host['subscribers'].publish(SESSION, journal)
    expect(pane.received().batches).toBe(delivered)
  })
})
