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
  let refuseTerminal = 0
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    tryAppendItem: (identity: AgentJournalItemIdentity, body) => {
      if (body.kind === 'turn' && body.state !== 'running' && refuseTerminal > 0) {
        refuseTerminal -= 1
        return { accepted: false, reason: 'backpressure' }
      }
      rows.push({ key: agentJournalItemKey(identity), body })
      return { accepted: true }
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  return {
    sink,
    rows,
    refuseNextTerminalWrite: () => {
      refuseTerminal += 1
    }
  }
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

/** Every lifecycle write for a turn, in order: what a reader could observe. */
function turnWrites(rows: readonly Row[], turnId: string) {
  return rows.flatMap((row) =>
    row.body.kind === 'turn' && row.body.turnId === turnId ? [row.body] : []
  )
}

function terminalWrites(rows: readonly Row[], turnId: string) {
  return turnWrites(rows, turnId).filter((body) => body.state !== 'running')
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

describe('a Codex turn ends once, on its completion', () => {
  it('records the failed completion Codex sends after the error, with the start this host saw', () => {
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
      completedAt: 2_100,
      durationMs: 1_100
    })
    expect(
      tap.rows.filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toHaveLength(1)
  })

  it('records an exit between the error and the completion as interrupted, with no verdict', () => {
    // Orca records only an end it observed. The exit is that end; the failure
    // Codex would have named arrives only in the completion, which never came.
    const tap = recorder()
    const codex = translator(tap)
    const events: CodexStructuredSessionEvent[] = []
    runFailedTurn((event) => events.push(event))

    for (const event of events.slice(0, -1)) {
      codex.handle(event)
    }
    codex.handle({
      type: 'ended',
      sessionId: SESSION_ID,
      reason: 'lost child',
      cause: 'unexpected-exit',
      fence: 1,
      acquisitionGeneration: 'generation-1',
      observedAt: 2_050
    })

    expect(terminalWrites(tap.rows, TURN_ID)).toEqual([
      {
        kind: 'turn',
        turnId: TURN_ID,
        state: 'interrupted',
        userItemId: agentJournalSubmissionKey(CLIENT_MESSAGE_ID),
        startedAt: 1_000,
        requestedAt: 900,
        completedAt: 2_050
      }
    ])
    expect(
      tap.rows.filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toHaveLength(1)
  })

  it('revises the still-open turn with a send Codex echoes between the error and the completion', () => {
    // Codex records a failed turn's pending input after its `error` frame and
    // before `turn/completed`, so the echo belongs to a turn that is still open.
    const tap = recorder()
    const codex = translator(tap)
    const events: CodexStructuredSessionEvent[] = []
    runFailedTurn((event) => events.push(event))
    const [started, echo, reply, error, completion] = events

    for (const event of [started, reply, error, echo, completion]) {
      if (event) {
        codex.handle(event)
      }
    }

    expect(turnWrites(tap.rows, TURN_ID).map((body) => body.state)).toEqual([
      'running',
      'running',
      'completed'
    ])
    expect(settledRecord(tap.rows, TURN_ID)).toMatchObject({
      outcome: 'failure',
      userItemId: agentJournalSubmissionKey(CLIENT_MESSAGE_ID),
      requestedAt: 900,
      startedAt: 1_000,
      durationMs: 1_100
    })
  })

  it('settles once when the sink refuses the completion and its retry lands', () => {
    // A refused frame is Orca's only redelivery of a completion, and a refused
    // end changes nothing, so the retry settles the turn exactly once.
    const tap = recorder()
    const codex = translator(tap)
    const completion = notification(
      'turn/completed',
      { turn: { id: TURN_ID, status: 'completed', durationMs: 900 } },
      2_000
    )

    codex.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    tap.refuseNextTerminalWrite()
    expect(codex.handle(completion)).toEqual({ accepted: false, reason: 'backpressure' })
    expect(codex.handle(completion)).toEqual({ accepted: true })

    expect(terminalWrites(tap.rows, TURN_ID)).toEqual([
      expect.objectContaining({
        state: 'completed',
        outcome: 'success',
        startedAt: 1_000,
        completedAt: 2_000,
        durationMs: 900
      })
    ])
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
