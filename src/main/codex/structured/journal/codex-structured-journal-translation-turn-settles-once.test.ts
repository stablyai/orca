import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'

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

function turnWrites(rows: readonly Row[], turnId: string) {
  return rows.flatMap((row) =>
    row.body.kind === 'turn' && row.body.turnId === turnId ? [row.body] : []
  )
}

function terminalWrites(rows: readonly Row[], turnId: string) {
  return turnWrites(rows, turnId).filter((body) => body.state !== 'running')
}

describe('a Codex turn ends once, on its completion', () => {
  it('settles once when the sink refuses the completion and its retry lands', () => {
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
})
