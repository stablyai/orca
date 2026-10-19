// The bounded-frame invariant: no frame the host emits to a `boundedFrames` subscriber is larger
// than a phone's bridge frame, whatever the chat holds. Each case below is a worst case for one
// thing a frame can carry; the last puts them all in one chat.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalSubmission,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionQueuedMessage,
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../shared/mobile-bridge-frame-bytes'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { BOUNDED_FRAME_ROW_BYTES, boundedFrameItem } from './agent-session-bounded-frame-item'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { readAgentSessionHistory } from './agent-session-history-page'
import { jsonBytes } from './json-string-shortening'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { QueuePublication } from './structured-agent-session-queued-publication'

// Longest id a client may name a session by, so the ids every frame repeats are at their widest.
const SESSION = `s${'x'.repeat(511)}`
// Escaped (6 bytes), multi-byte (3 bytes) and astral (4 bytes) text, so a budget counted in
// characters rather than serialized bytes would overflow.
const WIDE_TEXT = '\u0001한😀'

let root: string
let journal: AgentSessionJournal
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bounded-frames-'))
  journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: root
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

let ordinal = 0
function identity(): AgentJournalItemIdentity {
  ordinal += 1
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

async function append(body: AgentJournalItemBody): Promise<void> {
  await journal.appendItem(identity(), body, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
}

const message = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})

const output = (head: string) => ({
  head,
  byteLength: 40 * 1024 * 1024,
  digest: 'f'.repeat(64),
  truncated: true
})

/** The frame a phone's bridge carries for `payload`: its envelope around the event. */
function bridgeFrameBytes(payload: AgentSessionSubscribeEvent): number {
  return jsonBytes({ v: 1, type: 'event', id: crypto.randomUUID(), seq: 2 ** 31, payload })
}

function rendered(item: Partial<AgentJournalRenderItem> & { body: AgentJournalItemBody }) {
  return { itemId: 'item-1', revision: 1, sequence: 1, observedAt: 1, ...item }
}

describe('a bounded row', () => {
  it('never weighs more than its share of a page, whatever its fields hold', () => {
    const rows = [
      rendered({ body: message(WIDE_TEXT.repeat(400_000)) }),
      rendered({
        body: {
          kind: 'tool-call',
          name: 'Write',
          state: 'completed',
          input: { file_path: '/repo/a.ts', content: WIDE_TEXT.repeat(400_000) },
          output: output(WIDE_TEXT.repeat(4_000))
        }
      }),
      // Too many short strings to shorten: the row becomes the too-large marker.
      rendered({
        body: {
          kind: 'question',
          question: 'Pick one',
          options: Array.from({ length: 20_000 }, (_, index) => ({ id: `o${index}`, label: 'x' })),
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
      }),
      // Identifiers are never shortened, so they are what the marker must bound itself.
      rendered({
        itemId: 'i'.repeat(5 * 1024 * 1024),
        agentId: 'a'.repeat(5 * 1024 * 1024),
        parentAgentId: 'p'.repeat(5 * 1024 * 1024),
        providerParentRef: 'r'.repeat(5 * 1024 * 1024),
        turnScope: { kind: 'turn', turnItemId: 't'.repeat(5 * 1024 * 1024) },
        body: message('short')
      })
    ]
    for (const row of rows) {
      expect(jsonBytes(boundedFrameItem(row))).toBeLessThanOrEqual(BOUNDED_FRAME_ROW_BYTES)
    }
  })

  it('is the stored row when it already fits', () => {
    const row = rendered({ body: message('hello') })
    expect(boundedFrameItem(row)).toBe(row)
  })
})

describe('frames to a bounded-frame subscriber', () => {
  it('delivers every effective send within the byte budget on open, replay and no-row changes', async () => {
    const cursor = journal.cursor()
    const ids = Array.from({ length: 255 }, (_, index) => `unconfirmed-${index}`)
    const options = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`option-${index}`, 'x'.repeat(512)])
    )
    for (const clientMessageId of ids) {
      await journal.appendSubmission({
        clientMessageId,
        payloadFingerprint: 'a'.repeat(64),
        fence: 1,
        handoverRecorded: true,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
        options
      })
      await journal.resolveDispatch({
        clientMessageId,
        state: 'pending',
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    }
    for (let index = 0; index < 9; index++) {
      await append(message('x'.repeat(73_700)))
    }
    let held: ReadonlySet<string> = new Set()
    const subscribers = new AgentSessionSubscribers({
      readCurrentWork: () =>
        new StructuredAgentSessionCurrentWork(
          journal,
          1,
          0,
          undefined,
          undefined,
          false,
          () => held
        )
    })
    const frames: AgentSessionSubscribeEvent[] = []
    const emit = (event: AgentSessionSubscribeEvent) => frames.push(event)
    const check = (state: 'pending' | 'unknown'): void => {
      const delivered = new Map<string, AgentJournalSubmission>()
      for (const frame of frames) {
        expect(bridgeFrameBytes(frame)).toBeLessThanOrEqual(MOBILE_BRIDGE_MAX_FRAME_BYTES)
        const submissions =
          frame.type === 'batch'
            ? frame.batch.submissions
            : frame.type === 'snapshot' || frame.type === 'reset'
              ? frame.page.submissions
              : []
        if (frame.type === 'batch') {
          expect(submissions.length).toBeLessThanOrEqual(AGENT_SESSION_HISTORY_MAX_LIMIT)
          expect(frame.working).toBe(state === 'pending')
        }
        for (const submission of submissions) {
          delivered.set(submission.clientMessageId, submission)
        }
      }
      expect([...delivered.keys()].sort()).toEqual([...ids].sort())
      expect(
        [...delivered.values()].every((submission) => submission.dispatchState === state)
      ).toBe(true)
    }
    const close = subscribers.open({
      id: 'phone',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit,
      boundedFrames: true
    })
    check('unknown')
    close()
    frames.length = 0
    subscribers.open({
      id: 'old-client',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit,
      boundedFrames: true,
      cursor,
      snapshotCatchUp: false
    })
    expect(
      frames.filter((frame) => frame.type === 'batch' && frame.batch.items.length).length
    ).toBeGreaterThan(1)
    check('unknown')
    frames.length = 0
    held = new Set(ids)
    subscribers.publish(SESSION, journal)
    check('pending')
    for (const frame of frames) {
      expect(frame).toMatchObject({
        type: 'batch',
        batch: { cursor: journal.cursor(), items: [] }
      })
    }
  })

  function largeQueue(): QueuePublication {
    // What an older build admitted under its 1 MiB bound.
    const queuedMessages: AgentSessionQueuedMessage[] = Array.from({ length: 40 }, (_, index) => ({
      messageId: `draft-${index}`,
      position: index,
      state: 'waiting',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: WIDE_TEXT.repeat(4_000) }]
      }
    }))
    return { queuedMessages, queuePause: null, nextQueuedMessageId: 'draft-0' }
  }

  const largeRoster: AgentSessionBackgroundTaskState = {
    state: 'monitoring',
    tasks: Array.from({ length: 2_000 }, (_, index) => ({
      id: `task-${index}`,
      kind: 'command',
      description: WIDE_TEXT.repeat(200)
    }))
  }

  const largeCommands: AgentSessionSlashCommand[] = Array.from({ length: 20_000 }, (_, index) => ({
    name: `command-${index}`,
    kind: 'command',
    description: WIDE_TEXT.repeat(50)
  }))

  async function fillChat(): Promise<void> {
    for (let index = 0; index < 30; index += 1) {
      await append(message(WIDE_TEXT.repeat(30_000)))
      await append({
        kind: 'tool-call',
        name: 'Bash',
        state: 'completed',
        input: { command: WIDE_TEXT.repeat(3_000) },
        output: output(WIDE_TEXT.repeat(4_000))
      })
    }
  }

  it('each fit a phone bridge frame, from the opening snapshot through catch-up and live rows', async () => {
    await fillChat()
    const queue = largeQueue()
    const subscribers = new AgentSessionSubscribers({
      readQueuePublication: () => queue,
      readBackgroundTasks: () => largeRoster,
      readCommands: () => largeCommands
    })
    const frames: AgentSessionSubscribeEvent[] = []
    const emit = (event: AgentSessionSubscribeEvent): void => {
      frames.push(event)
    }
    subscribers.open({
      id: 'opening',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit,
      boundedFrames: true
    })
    subscribers.open({
      id: 'catch-up',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit,
      cursor: { epoch: journal.epoch, sequence: 0 },
      boundedFrames: true
    })
    await fillChat()
    subscribers.publish(SESSION, journal, { turnId: 't'.repeat(100_000), text: 'working' })
    subscribers.snapshot(SESSION, journal, 1)

    expect(frames.length).toBeGreaterThan(4)
    for (const frame of frames) {
      expect(bridgeFrameBytes(frame)).toBeLessThanOrEqual(MOBILE_BRIDGE_MAX_FRAME_BYTES)
      expect(frame).not.toHaveProperty('commands')
    }
    // The side lists still arrive, each in a frame of its own.
    const cards = frames.flatMap((frame) =>
      frame.type === 'batch' && frame.queuedMessages ? [frame.queuedMessages] : []
    )
    // Whole cards from the front: an older build's 1 MiB queue lists what fits.
    const listed = cards.at(-1) ?? []
    expect(listed.length).toBeGreaterThan(0)
    expect(listed).toEqual(queue.queuedMessages.slice(0, listed.length))
    expect(frames.some((frame) => frame.type === 'batch' && frame.backgroundTasks)).toBe(true)
  })

  it('keep a burst of rows to one page, so no publish outruns the bridge window', async () => {
    const queue = largeQueue()
    const subscribers = new AgentSessionSubscribers({
      readQueuePublication: () => queue,
      readBackgroundTasks: () => largeRoster
    })
    const frames: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'phone',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => frames.push(event),
      boundedFrames: true
    })
    // About 10 MB of rows land before one publish, as a drain of buffered events can.
    for (let index = 0; index < 40; index += 1) {
      await append(message('x'.repeat(256 * 1024)))
    }
    frames.length = 0
    subscribers.publish(SESSION, journal)

    // The phone's shell ends a stream past 4 MiB unacked.
    const bytes = frames.reduce((sum, frame) => sum + bridgeFrameBytes(frame), 0)
    expect(bytes).toBeLessThan(4 * 1024 * 1024)
    // One page of rows; the rest are the side lists a hydrating frame owes.
    const [tail, ...side] = frames
    expect(tail?.type === 'snapshot' && tail.page).toMatchObject({ hasOlder: true })
    expect(side.every((frame) => frame.type === 'batch' && frame.batch.items.length === 0)).toBe(
      true
    )
    // Live rows after it arrive as batches again.
    await append(message('next'))
    const live = frames.length
    subscribers.publish(SESSION, journal)
    expect(frames.slice(live).map((frame) => frame.type)).toEqual(['batch'])

    // A phone that applied all of it pages back to the first row with no gap.
    let state = frames.reduce(
      (current, event) => reduceStructuredAgentSession(current, { type: 'event', event }),
      EMPTY_STRUCTURED_AGENT_SESSION
    )
    for (let cursor = oldestStructuredAgentSessionCursor(state); state.hasOlder && cursor;) {
      const older = readAgentSessionHistory(journal, {
        sessionId: SESSION,
        direction: 'before',
        cursor
      })
      state = reduceStructuredAgentSession(state, {
        type: 'older-page',
        requestedCursor: cursor,
        page: older.page
      })
      cursor = oldestStructuredAgentSessionCursor(state)
    }
    expect(state.items.map((item) => item.sequence)).toEqual(
      journal.snapshot().items.map((item) => item.sequence)
    )
  })

  it('leave out a turn record no real provider id could make too large, rather than outgrow', async () => {
    await journal.appendItem(
      identity(),
      { kind: 'turn', turnId: 'u'.repeat(100_000), state: 'running' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const frames: AgentSessionSubscribeEvent[] = []
    new AgentSessionSubscribers().open({
      id: 'phone',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => frames.push(event),
      boundedFrames: true
    })
    const [snapshot] = frames
    expect(bridgeFrameBytes(snapshot!)).toBeLessThanOrEqual(MOBILE_BRIDGE_MAX_FRAME_BYTES)
    expect(snapshot?.type === 'snapshot' && snapshot.page).not.toHaveProperty('latestTurn')
  })

  it('leave every other subscriber the frames it had', async () => {
    const stored = message(WIDE_TEXT.repeat(30_000))
    await append(stored)
    const queue = largeQueue()
    const frames: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers({
      readQueuePublication: () => queue,
      readBackgroundTasks: () => largeRoster,
      readCommands: () => largeCommands
    })
    subscribers.open({
      id: 'desktop',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => frames.push(event)
    })
    await append(stored)
    subscribers.publish(SESSION, journal)

    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({
      type: 'snapshot',
      commands: largeCommands,
      queuedMessages: queue.queuedMessages,
      backgroundTasks: largeRoster
    })
    // Rows as stored, whole.
    for (const frame of frames) {
      const items =
        frame.type === 'snapshot'
          ? frame.page.items
          : frame.type === 'batch'
            ? frame.batch.items
            : []
      expect(items.map((item) => item.body)).toEqual(items.map(() => stored))
    }
  })
})
