import { describe, expect, it } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
import {
  buildJournalDispatchRow,
  buildJournalItemRow,
  buildJournalSubmissionRow
} from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'

const TURN_1: AgentJournalItemIdentity = { provider: 'orca', clientMessageId: 'turn-1' }
const TURN_2: AgentJournalItemIdentity = { provider: 'orca', clientMessageId: 'turn-2' }
const COMMAND_TURN: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'command-turn:cmd-1'
}
const inTurn = (identity: AgentJournalItemIdentity): AgentJournalTurnScope => ({
  kind: 'turn',
  turnItemId: agentJournalItemKey(identity)
})

function row(id: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: id }
}

function prose(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

function turn(turnId: string, state: 'running' | 'completed'): AgentJournalItemBody {
  return { kind: 'turn', turnId, state, startedAt: 1 }
}

/** Builds rows against a scratch state, so the same list can be folded more than once. */
function rows() {
  const state = createJournalReducerState('session-1', 'epoch-1')
  const built: JournalRow[] = []
  let seq = 0
  const push = (next: JournalRow): void => {
    built.push(next)
    applyJournalRow(state, next)
  }
  return {
    state,
    built,
    item(
      identity: AgentJournalItemIdentity,
      body: AgentJournalItemBody,
      scope?: AgentJournalTurnScope
    ) {
      seq += 1
      const next = buildJournalItemRow({
        state,
        identity,
        body,
        seq,
        fence: 1,
        ts: 1_000 + seq,
        turnScope: scope ?? AGENT_JOURNAL_THREAD_SCOPE
      })
      if (!scope) {
        // A row from a host that predates stated scopes.
        delete next.turnScope
      }
      push(next)
    },
    submission(clientMessageId: string) {
      seq += 1
      push(
        buildJournalSubmissionRow({
          state,
          clientMessageId,
          payloadFingerprint: `fp-${clientMessageId}`,
          providerHandle: { kind: 'codex', threadId: 'thread-1' },
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: clientMessageId }]
          },
          seq,
          fence: 1,
          ts: 1_000 + seq,
          handoverRecorded: true
        })
      )
    },
    handover(clientMessageId: string, scope?: AgentJournalTurnScope) {
      seq += 1
      push(
        buildJournalDispatchRow({
          state,
          clientMessageId,
          dispatchState: 'pending',
          providerItemId: null,
          reason: null,
          seq,
          fence: 1,
          ts: 1_000 + seq,
          ...(scope ? { turnScope: scope } : {})
        })
      )
    }
  }
}

function scopeOf(state: JournalReducerState, identity: AgentJournalItemIdentity) {
  return state.items.get(agentJournalItemKey(identity))?.turnScope
}

function submissionScope(state: JournalReducerState, clientMessageId: string) {
  return state.items.get(agentJournalSubmissionKey(clientMessageId))?.turnScope
}

function refold(built: readonly JournalRow[]) {
  const state = createJournalReducerState('session-1', 'epoch-1')
  for (const next of built) {
    applyJournalRow(state, next)
  }
  return renderJournalState(state)
}

describe('stated turn scope', () => {
  it('keeps the scope of the write that created the row', () => {
    const { state, item } = rows()
    item(TURN_1, turn('t1', 'running'), AGENT_JOURNAL_THREAD_SCOPE)
    item(row('answer'), prose('first'), inTurn(TURN_1))
    // A revision stating another scope only updates the content.
    item(row('answer'), prose('second'), AGENT_JOURNAL_THREAD_SCOPE)
    expect(scopeOf(state, row('answer'))).toEqual(inTurn(TURN_1))
  })

  it('places a queued message only when its handover states a turn', () => {
    const { state, item, submission, handover } = rows()
    item(TURN_1, turn('t1', 'running'), AGENT_JOURNAL_THREAD_SCOPE)
    submission('steer')
    submission('later')
    // Accepted while a turn runs, but not yet delivered into it.
    expect(submissionScope(state, 'steer')).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
    handover('steer', inTurn(TURN_1))
    handover('later', AGENT_JOURNAL_THREAD_SCOPE)
    expect(submissionScope(state, 'steer')).toEqual(inTurn(TURN_1))
    expect(submissionScope(state, 'later')).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
  })

  it('keeps a message held behind a command out of the command turn', () => {
    const { state, item, submission, handover } = rows()
    submission('cmd-1')
    handover('cmd-1', AGENT_JOURNAL_THREAD_SCOPE)
    item(COMMAND_TURN, turn('compact:cmd-1', 'running'), AGENT_JOURNAL_THREAD_SCOPE)
    submission('held')
    expect(submissionScope(state, 'held')).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
    item(COMMAND_TURN, turn('compact:cmd-1', 'completed'), AGENT_JOURNAL_THREAD_SCOPE)
    handover('held', AGENT_JOURNAL_THREAD_SCOPE)
    expect(submissionScope(state, 'held')).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
  })
})

describe('scope derived for rows stored without one', () => {
  it('places rows inside a live span and closes it at the terminal revision', () => {
    const { state, item } = rows()
    item(row('before'), prose('before'))
    item(TURN_1, turn('t1', 'running'))
    item(row('inside'), prose('inside'))
    item(TURN_1, turn('t1', 'completed'))
    item(row('after'), prose('after'))
    expect(scopeOf(state, row('before'))).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
    expect(scopeOf(state, TURN_1)).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
    expect(scopeOf(state, row('inside'))).toEqual(inTurn(TURN_1))
    expect(scopeOf(state, row('after'))).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
  })

  it('keeps a turn rebuilt already settled open until the next turn record', () => {
    const { state, item } = rows()
    item(TURN_1, turn('t1', 'completed'))
    item(row('first'), prose('first'))
    item(TURN_2, turn('t2', 'completed'))
    item(row('second'), prose('second'))
    expect(scopeOf(state, row('first'))).toEqual(inTurn(TURN_1))
    expect(scopeOf(state, row('second'))).toEqual(inTurn(TURN_2))
  })

  it('closes a legacy /compact carrier where its turn body is overwritten, and shows the carrier', () => {
    const { state, item } = rows()
    const carrier = row('compact:op-1')
    item(carrier, {
      kind: 'status',
      text: 'Compacting conversation…',
      turnLifecycle: { turnId: 'compact:op-1', state: 'running' }
    })
    item(row('summary'), prose('summary'))
    item(carrier, { kind: 'status', text: 'Conversation compacted.' })
    item(row('after'), prose('after'))
    expect(scopeOf(state, carrier)).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
    expect(scopeOf(state, row('summary'))).toEqual(inTurn(carrier))
    expect(scopeOf(state, row('after'))).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
  })

  it('lands rows written after a crash left a turn running in that turn', () => {
    const { state, item } = rows()
    item(TURN_1, turn('t1', 'running'))
    item(row('crash-window'), prose('written before the sweep'))
    expect(scopeOf(state, row('crash-window'))).toEqual(inTurn(TURN_1))
  })

  it('derives the same scopes on replay as live', () => {
    const { state, built, item, submission, handover } = rows()
    item(TURN_1, turn('t1', 'running'))
    item(row('inside'), prose('inside'))
    submission('steer')
    handover('steer')
    item(TURN_1, turn('t1', 'completed'))
    item(row('after'), prose('after'))
    expect(submissionScope(state, 'steer')).toEqual(inTurn(TURN_1))
    expect(refold(built)).toEqual(renderJournalState(state))
  })
})
