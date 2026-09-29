import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'
const NEXT_TURN_ID = 'turn-2'
const CLIENT_MESSAGE_ID = 'client-1'

type Row = { key: string; body: AgentJournalItemBody }

function recorder() {
  const rows: Row[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: () => {},
    publish: () => {}
  }
  return { sink, rows }
}

function notification(method: string, params: unknown, observedAt: number) {
  return {
    type: 'notification',
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    method,
    params,
    observedAt
  } satisfies CodexStructuredSessionEvent
}

function translator(tap: ReturnType<typeof recorder>) {
  return createCodexJournalTranslator({
    sink: tap.sink,
    sessionId: SESSION_ID,
    primaryThreadId: () => THREAD_ID,
    dispatchRequestOrigin: () => ({ requestedAt: 900, sequence: 0 })
  })
}

/** Every terminal write for a turn, in order: what a reader could observe. */
function terminalWrites(rows: readonly Row[], turnId: string) {
  return rows
    .map((row) => row.body)
    .filter((body) => body.kind === 'turn' && body.turnId === turnId && body.state !== 'running')
}

/** The body the journal reducer keeps for a turn's lifecycle row. */
function settledRecord(rows: readonly Row[], turnId: string) {
  return rows
    .map((row) => row.body)
    .findLast((body) => body.kind === 'turn' && body.turnId === turnId)
}

/** Codex's frames for a turn that fails: the error, then the failed completion. */
function runFailedTurn(handle: (event: CodexStructuredSessionEvent) => unknown) {
  handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
  handle(
    notification(
      'item/started',
      {
        turnId: TURN_ID,
        turn: { id: TURN_ID },
        item: { type: 'userMessage', id: 'user-1', clientId: CLIENT_MESSAGE_ID }
      },
      1_100
    )
  )
  handle(
    notification(
      'item/completed',
      {
        turnId: TURN_ID,
        item: { type: 'agentMessage', id: 'agent-1', text: 'Checking the build' }
      },
      1_500
    )
  )
  handle(
    notification(
      'error',
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        willRetry: false,
        error: { message: 'stream disconnected before completion' }
      },
      2_000
    )
  )
  handle(
    notification(
      'turn/completed',
      { turn: { id: TURN_ID, status: 'failed', durationMs: 1_100 } },
      2_100
    )
  )
}

describe('a Codex turn settles once', () => {
  it('keeps the failure the error settled when the failed completion follows it', () => {
    const tap = recorder()
    const codex = translator(tap)

    runFailedTurn((event) => codex.handle(event))

    expect(terminalWrites(tap.rows, TURN_ID)).toHaveLength(1)
    expect(settledRecord(tap.rows, TURN_ID)).toEqual({
      kind: 'turn',
      turnId: TURN_ID,
      state: 'completed',
      outcome: 'failure',
      userItemId: agentJournalSubmissionKey(CLIENT_MESSAGE_ID),
      startedAt: 1_000,
      requestedAt: 900,
      completedAt: 2_000
    })
    expect(
      tap.rows.filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toHaveLength(1)
  })

  it('ignores a duplicate completion for a turn it already settled', () => {
    const tap = recorder()
    const codex = translator(tap)

    codex.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    codex.handle(
      notification(
        'turn/completed',
        { turn: { id: TURN_ID, status: 'completed', durationMs: 900 } },
        2_000
      )
    )
    codex.handle(notification('turn/completed', { turn: { id: TURN_ID, status: 'failed' } }, 3_000))

    expect(terminalWrites(tap.rows, TURN_ID)).toHaveLength(1)
    expect(settledRecord(tap.rows, TURN_ID)).toMatchObject({
      state: 'completed',
      outcome: 'success',
      startedAt: 1_000,
      completedAt: 2_000,
      durationMs: 900
    })
  })

  it('settles an ordinary turn exactly as before', () => {
    const tap = recorder()
    const codex = translator(tap)

    codex.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    codex.handle(
      notification(
        'turn/completed',
        { turn: { id: TURN_ID, status: 'completed', durationMs: 3_250 } },
        4_500
      )
    )

    expect(terminalWrites(tap.rows, TURN_ID)).toEqual([
      {
        kind: 'turn',
        turnId: TURN_ID,
        state: 'completed',
        outcome: 'success',
        userItemId: `codex:${THREAD_ID}:${TURN_ID}:0`,
        startedAt: 1_000,
        completedAt: 4_500,
        durationMs: 3_250
      }
    ])
  })

  it('settles the next turn on its own after a failed one', () => {
    const tap = recorder()
    const codex = translator(tap)

    runFailedTurn((event) => codex.handle(event))
    const failed = settledRecord(tap.rows, TURN_ID)
    codex.handle(notification('turn/started', { turn: { id: NEXT_TURN_ID } }, 3_000))
    codex.handle(
      notification(
        'turn/completed',
        { turn: { id: NEXT_TURN_ID, status: 'completed', durationMs: 1_000 } },
        4_000
      )
    )

    expect(settledRecord(tap.rows, TURN_ID)).toEqual(failed)
    expect(terminalWrites(tap.rows, NEXT_TURN_ID)).toHaveLength(1)
    expect(settledRecord(tap.rows, NEXT_TURN_ID)).toMatchObject({
      state: 'completed',
      outcome: 'success',
      startedAt: 3_000,
      completedAt: 4_000
    })
  })
})
