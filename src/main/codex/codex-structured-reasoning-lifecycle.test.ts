// Every way a Codex reasoning row opens and ends.
import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexJournalItems } from './codex-structured-journal-items'
import { MAX_CODEX_ACTIVE_ITEMS } from './codex-structured-journal-limits'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'
const ROW = 'orca:codex-item%3Athread-abc%3Ar-1'

function recorder() {
  const rows = new Map<string, AgentJournalItemBody>()
  /** The host time each row's first write asked to be stamped with. */
  const firstObservedAt = new Map<string, number | undefined>()
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => {
      const key = agentJournalItemKey(identity)
      if (!rows.has(key)) {
        firstObservedAt.set(key, options.observedAt)
      }
      rows.set(key, body)
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  return { rows, sink, firstObservedAt }
}

function notification(
  method: string,
  params: unknown,
  observedAt?: number
): CodexStructuredSessionEvent {
  return {
    type: 'notification',
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    method,
    params,
    ...(observedAt === undefined ? {} : { observedAt })
  }
}

function reasoning(id: string, summary: string[] = []) {
  return { item: { type: 'reasoning', id, summary, content: [] } }
}

function streamingTurn() {
  const { rows, sink, firstObservedAt } = recorder()
  const translator = createCodexJournalTranslator({
    sink,
    primaryThreadId: () => THREAD_ID,
    sessionId: SESSION_ID,
    // Deltas are written as they arrive, so the open row is visible without a timer.
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
  translator.handle(notification('item/started', reasoning('r-1'), 2_000))
  // Production times only turn and item boundaries at receipt; a delta carries no time.
  translator.handle(
    notification('item/reasoning/summaryTextDelta', { itemId: 'r-1', delta: 'Planning' })
  )
  return { rows, translator, firstObservedAt }
}

/** A turn whose deltas wait out the coalescing window, as they do in production. */
function coalescedTurn(now?: () => number) {
  const { rows, sink, firstObservedAt } = recorder()
  const translator = createCodexJournalTranslator({
    sink,
    primaryThreadId: () => THREAD_ID,
    sessionId: SESSION_ID,
    schedule: () => () => {},
    ...(now ? { now } : {})
  })
  translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
  return { rows, translator, firstObservedAt }
}

describe('a Codex reasoning row', () => {
  it('writes no row while its item has no text, and opens with its first summary text', () => {
    const { rows, sink } = recorder()
    const translator = createCodexJournalTranslator({ sink, primaryThreadId: () => THREAD_ID })
    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    translator.handle(notification('item/started', reasoning('r-1'), 2_000))
    expect(rows.get(ROW)).toBeUndefined()
    const streamed = streamingTurn()
    expect(streamed.rows.get(ROW)).toMatchObject({ state: 'running' })
  })

  it('starts when its item started, though its first text came later', () => {
    const { firstObservedAt } = streamingTurn()
    expect(firstObservedAt.get(ROW)).toBe(2_000)
  })

  // Captured: summary text lands 13–50 ms before item/completed, inside one coalescing window.
  it('starts at item/started when its first write is the completion itself', () => {
    const streamed = coalescedTurn()
    streamed.translator.handle(notification('item/started', reasoning('r-1'), 2_000))
    streamed.translator.handle(
      notification('item/reasoning/summaryTextDelta', { itemId: 'r-1', delta: 'Planning' })
    )
    streamed.translator.handle(
      notification('item/completed', reasoning('r-1', ['Planning']), 7_650)
    )
    expect(streamed.firstObservedAt.get(ROW)).toBe(2_000)
    expect(streamed.rows.get(ROW)).toMatchObject({ state: 'completed', completedAt: 7_650 })

    const completedOnly = coalescedTurn()
    completedOnly.translator.handle(notification('item/started', reasoning('r-1'), 2_000))
    completedOnly.translator.handle(
      notification('item/completed', reasoning('r-1', ['Planning']), 7_650)
    )
    expect(completedOnly.firstObservedAt.get(ROW)).toBe(2_000)
  })

  it('times its start and end on the host clock when a boundary arrives without a time', () => {
    let now = 2_000
    const { translator, rows, firstObservedAt } = coalescedTurn(() => now)
    translator.handle(notification('item/started', reasoning('r-1')))
    now = 6_000
    translator.handle(notification('item/completed', reasoning('r-1', ['Planning'])))
    expect(firstObservedAt.get(ROW)).toBe(2_000)
    expect(rows.get(ROW)).toMatchObject({ completedAt: 6_000 })
  })

  it('ends when its item completes, at the completion it saw', () => {
    const { rows, translator } = streamingTurn()
    translator.handle(notification('item/completed', reasoning('r-1', ['Planning']), 5_000))
    expect(rows.get(ROW)).toEqual({
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Planning' }],
      state: 'completed',
      completedAt: 5_000
    })
  })

  it('ends with its turn when the item never completes', () => {
    const { rows, translator } = streamingTurn()
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }, 6_000))
    expect(rows.get(ROW)).toMatchObject({ state: 'completed', completedAt: 6_000 })
  })

  it('ends when the provider exits mid-item', () => {
    const { rows, translator } = streamingTurn()
    translator.handle({ type: 'ended', sessionId: SESSION_ID, reason: 'exit', observedAt: 7_000 })
    expect(rows.get(ROW)).toMatchObject({ state: 'completed', completedAt: 7_000 })
  })

  it('replays from history as ended, with no span it never saw', () => {
    const { rows, sink } = recorder()
    const items = new CodexJournalItems(
      { sink, attributionFor: () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE }) },
      () => TURN_ID,
      () => {}
    )
    items.handle(
      { threadId: THREAD_ID, method: 'item/completed', params: reasoning('r-1', ['Planned']) },
      'history'
    )
    expect(rows.get(ROW)).toMatchObject({ state: 'completed' })
    expect(rows.get(ROW)).not.toHaveProperty('completedAt')
  })

  it('ends with its streamed text and no claimed time when the bounded live set drops it', () => {
    const { rows, sink } = recorder()
    const items = new CodexJournalItems(
      {
        sink,
        attributionFor: () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE }),
        schedule: () => () => {}
      },
      () => TURN_ID,
      () => {}
    )
    // As captured: a started reasoning item carries an empty summary; its text only streams.
    items.handle({ threadId: THREAD_ID, method: 'item/started', params: reasoning('r-1') })
    items.streams.handle(THREAD_ID, 'item/reasoning/summaryTextDelta', {
      itemId: 'r-1',
      delta: 'Thinking'
    })
    expect(rows.get(ROW)).toBeUndefined()
    for (let index = 2; index <= MAX_CODEX_ACTIVE_ITEMS + 1; index += 1) {
      items.handle({ threadId: THREAD_ID, method: 'item/started', params: reasoning(`r-${index}`) })
    }
    expect(rows.get(ROW)).toEqual({
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Thinking' }],
      state: 'completed'
    })
  })

  it('ends with its streamed text when the completion itself carries none', () => {
    const { translator, rows } = coalescedTurn()
    translator.handle(notification('item/started', reasoning('r-1'), 2_000))
    translator.handle(
      notification('item/reasoning/summaryTextDelta', { itemId: 'r-1', delta: '**Plan**' })
    )
    translator.handle(notification('item/completed', reasoning('r-1'), 7_000))
    expect(rows.get(ROW)).toEqual({
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: '**Plan**' }],
      state: 'completed',
      completedAt: 7_000
    })
  })

  it('claims no span for a completion whose start was never seen', () => {
    const { translator, rows } = coalescedTurn()
    translator.handle(notification('item/completed', reasoning('r-1', ['Planned']), 7_000))
    expect(rows.get(ROW)).toMatchObject({ state: 'completed' })
    expect(rows.get(ROW)).not.toHaveProperty('completedAt')
  })

  it('leaves an evicted file change what a settle would, not its command output as a patch', () => {
    const { rows, sink } = recorder()
    const items = new CodexJournalItems(
      {
        sink,
        attributionFor: () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE }),
        schedule: () => () => {}
      },
      () => TURN_ID,
      () => {}
    )
    const changes = [{ path: 'src/app.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@' }]
    items.handle({
      threadId: THREAD_ID,
      method: 'item/started',
      params: { item: { type: 'fileChange', id: 'patch-1', changes, status: 'inProgress' } }
    })
    items.streams.handle(THREAD_ID, 'item/fileChange/outputDelta', {
      itemId: 'patch-1',
      delta: 'Success. Updated the following files:'
    })
    for (let index = 2; index <= MAX_CODEX_ACTIVE_ITEMS + 1; index += 1) {
      items.handle({ threadId: THREAD_ID, method: 'item/started', params: reasoning(`r-${index}`) })
    }
    expect(rows.get('orca:codex-item%3Athread-abc%3Apatch-1')).toEqual({
      kind: 'status',
      text: 'File changes were interrupted before completion.'
    })
  })

  it('keeps the start of an item whose started frame already carried text', () => {
    const { translator, rows, firstObservedAt } = coalescedTurn()
    translator.handle(notification('item/started', reasoning('r-1', ['Plan']), 2_000))
    expect(rows.get(ROW)).toMatchObject({ state: 'running' })
    translator.handle(notification('item/completed', reasoning('r-1', ['Plan']), 7_000))
    expect(firstObservedAt.get(ROW)).toBe(2_000)
    expect(rows.get(ROW)).toMatchObject({ state: 'completed', completedAt: 7_000 })
  })
})
