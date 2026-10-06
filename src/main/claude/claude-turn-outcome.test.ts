import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../shared/agent-session-turn-record'
import { describeNativeChatTurnStatus } from '../../shared/native-chat-turn-status'
import { selectStructuredAgentSettledTurns } from '../../shared/structured-agent-session-turn-timing'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { JournalStopEvent } from '../native-chat/agent-session-journal/journal-row-schema'
import {
  personStopDecidesTurn,
  type JournalLatestStop
} from '../native-chat/agent-session-journal/journal-stop-turn-end'
import { createJournalReducerState } from '../native-chat/agent-session-journal/journal-reducer'
import { claudeResultOutcome } from './claude-result-outcome'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { claudeResultFailure } from './claude-structured-provider-fallback'
import { claudeTurnEndForResult, claudeTurnLifecycleItem } from './claude-turn-lifecycle-item'

function sinkState() {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: () => {},
    publish: vi.fn()
  }
  return { sink, items }
}

function userTurn(uuid: string) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    startsTurn: true as const,
    message: {
      type: 'user',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'summarize this' }] }
    }
  }
}

function result(fields: Record<string, unknown>) {
  return { type: 'result', duration_ms: 1_200, ...fields }
}

const TURN = {
  sessionId: 'orca-session',
  turnId: 'user-1',
  startedAt: 1_000,
  userItemId: 'claude:user-1'
}

describe('claudeResultOutcome', () => {
  it('separates the provider failing from the user stopping it', () => {
    expect(claudeResultOutcome(result({ subtype: 'success', is_error: false }))).toBe('success')
    // The SDK reports a user stop as an error result, so the flag alone cannot
    // tell a cancellation from a fault; only the terminal reason does.
    expect(
      claudeResultOutcome(result({ is_error: true, terminal_reason: 'aborted_streaming' }))
    ).toBe('cancellation')
    expect(claudeResultOutcome(result({ is_error: true, terminal_reason: 'aborted_tools' }))).toBe(
      'cancellation'
    )
    expect(claudeResultOutcome(result({ is_error: true, terminal_reason: 'api_error' }))).toBe(
      'failure'
    )
    // A reason this build has never seen is still a reported failure, not a stop.
    expect(claudeResultOutcome(result({ is_error: true, terminal_reason: 'future_reason' }))).toBe(
      'failure'
    )
    expect(claudeResultOutcome(result({ is_error: true }))).toBe('failure')
  })

  it('reads the success-subtype result that carries an API error as a failure', () => {
    // The real captured shape: subtype `success`, `is_error` true. Trusting the
    // subtype is what let an API error be recorded as a clean turn.
    expect(
      claudeResultOutcome(
        result({
          subtype: 'success',
          is_error: true,
          result: 'API Error: 529 upstream overloaded',
          terminal_reason: 'api_error'
        })
      )
    ).toBe('failure')
  })

  it('is the single owner of the abort list the visible error row also reads', () => {
    // One classifier, so the durable verdict and the error row cannot disagree
    // about whether a stop was the user's.
    for (const reason of ['aborted_streaming', 'aborted_tools', 'api_error', 'future_reason']) {
      const message = result({ is_error: true, terminal_reason: reason, result: 'text' })
      expect(claudeResultFailure(message) !== null).toBe(claudeResultOutcome(message) === 'failure')
    }
    expect(claudeResultFailure(result({ is_error: false }))).toBeNull()
  })
})

describe('claudeTurnEndForResult', () => {
  it('records the verdict without moving the lifecycle arm', () => {
    // The arms are what six readers switch on. A failed turn is still a turn the
    // host watched finish, so it stays `completed` and only `outcome` says more.
    expect(
      claudeTurnEndForResult(result({ is_error: true, terminal_reason: 'api_error' }), 9_000)
    ).toEqual({ state: 'completed', outcome: 'failure', completedAt: 9_000, durationMs: 1_200 })
    expect(claudeTurnEndForResult(result({ is_error: false }), 9_000)).toEqual({
      state: 'completed',
      outcome: 'success',
      completedAt: 9_000,
      durationMs: 1_200
    })
    expect(
      claudeTurnEndForResult(result({ is_error: true, terminal_reason: 'aborted_tools' }), 9_000)
    ).toEqual({
      state: 'interrupted',
      outcome: 'cancellation',
      completedAt: 9_000,
      durationMs: 1_200
    })
  })
})

describe('claudeTurnLifecycleItem', () => {
  it('carries the verdict onto the terminal row and never onto the running one', () => {
    expect(readAgentJournalTurn(claudeTurnLifecycleItem(TURN).body)).toEqual({
      turnId: 'user-1',
      state: 'running',
      startedAt: 1_000,
      userItemId: 'claude:user-1'
    })
    expect(
      readAgentJournalTurn(
        claudeTurnLifecycleItem(TURN, {
          state: 'completed',
          outcome: 'failure',
          completedAt: 4_000
        }).body
      )
    ).toEqual({
      turnId: 'user-1',
      state: 'completed',
      outcome: 'failure',
      startedAt: 1_000,
      completedAt: 4_000,
      userItemId: 'claude:user-1'
    })
  })

  it('omits the verdict for an end the host inferred rather than heard', () => {
    // No provider result arrived, so nothing named a verdict. Writing one here
    // would be the host guessing, and absent already means unknown.
    const body = claudeTurnLifecycleItem(TURN, { state: 'interrupted', completedAt: 4_000 }).body
    expect(body).not.toHaveProperty('outcome')
    expect(readAgentJournalTurn(body)).toEqual({
      turnId: 'user-1',
      state: 'interrupted',
      startedAt: 1_000,
      completedAt: 4_000,
      userItemId: 'claude:user-1'
    })
  })
})

describe('a turn end the host inferred', () => {
  it('records no outcome for a turn ended by the child ending', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(userTurn('user-1'))
    translator.handle({ type: 'ended', sessionId: 'orca-session', reason: 'closed' })

    // No result frame arrived, so the provider never said what became of the
    // turn. The host observed the END — the arm stays `interrupted` — but the
    // verdict is unknown, and guessing `success` here is what a notification
    // gated on the outcome would fire on.
    const settled = state.items.find(
      (item) =>
        item.identity.provider === 'legacy' &&
        item.identity.recordId === 'turn-lifecycle:user-1' &&
        readAgentJournalTurn(item.body)?.state === 'interrupted'
    )
    expect(readAgentJournalTurn(settled?.body)).toMatchObject({ state: 'interrupted' })
    expect(settled?.body).not.toHaveProperty('outcome')
    expect(readAgentJournalTurnOutcome(readAgentJournalTurn(settled?.body))).toBeNull()
  })

  // The supersede fires for any send Orca dispatched, and nothing here says whether the user or
  // another agent sent it, so it is recorded as replaced, never as the user's stop or a fault.
  it('records a turn a newer send superseded as superseded, folded as interrupted', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    let observedAt = 1_000
    translator.handle({ ...userTurn('user-1'), observedAt })
    observedAt = 13_000
    translator.handle({ ...userTurn('user-2'), observedAt })

    // The journal as a reader holds it: each turn row at its newest revision, after the user row
    // it names (the host journals that row, not this translator).
    const rows = new Map<string, AgentJournalRenderItem>()
    state.items.forEach((item, index) => {
      const itemId = agentJournalItemKey(item.identity)
      rows.set(itemId, { itemId, revision: index, sequence: index, observedAt, body: item.body })
    })
    const items = [...rows.values()].flatMap((row): AgentJournalRenderItem[] => {
      const userItemId = readAgentJournalTurn(row.body)?.userItemId
      return userItemId
        ? [
            {
              ...row,
              itemId: userItemId,
              body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
            },
            row
          ]
        : [row]
    })
    const superseded = items.find((item) => readAgentJournalTurn(item.body)?.turnId === 'user-1')
    expect(readAgentJournalTurn(superseded?.body)).toMatchObject({
      state: 'interrupted',
      outcome: 'superseded'
    })
    const settled = selectStructuredAgentSettledTurns(items).get(
      readAgentJournalTurn(superseded?.body)?.userItemId ?? ''
    )
    expect(settled).toMatchObject({ verdict: 'superseded', workedSeconds: 12 })
    expect(
      settled && describeNativeChatTurnStatus({ elapsedSeconds: 0, ...settled })
    ).toMatchObject({ key: 'interruptedAfter', duration: '12s' })
  })
})

describe("a person's Stop inside a live turn", () => {
  // Claude CLIs before 2.1.91 send no terminal_reason, and later ones may omit it.
  const cutShort = { type: 'result', subtype: 'error_during_execution', is_error: true }

  /** A sink whose journal's latest Stop event is `stop`, answering by the journal's own rule. */
  function sinkWithStop(stop: JournalLatestStop | null) {
    const state = sinkState()
    const journal = createJournalReducerState('orca-session', 'epoch-1')
    journal.queuePauseMarks.latestStop = stop
    return {
      ...state,
      sink: {
        ...state.sink,
        journalStopDecidesTurn: (turnId: string, endedAt: number) =>
          personStopDecidesTurn(journal, turnId, endedAt)
      }
    }
  }

  function stopOf(
    turnId: string,
    reason: JournalStopEvent['reason'] = 'user-stop'
  ): JournalLatestStop {
    return { sequence: 9, event: { reason, turnId, at: 1 } }
  }

  function settledTurn(items: ReturnType<typeof sinkState>['items'], turnId: string) {
    return items
      .map((item) => readAgentJournalTurn(item.body))
      .findLast((turn) => turn?.turnId === turnId && turn.state !== 'running')
  }

  function providerRows(items: ReturnType<typeof sinkState>['items']): number {
    return items.filter(
      (item) =>
        item.identity.provider === 'orca' &&
        item.identity.clientMessageId.startsWith('provider-frame:')
    ).length
  }

  // Whose end it was is the journal's Stop rule to say as it writes the end (`turnEndAfterStop`).
  it("leaves an error result with no terminal reason after a person's Stop of the turn to that Stop", () => {
    const state = sinkWithStop(stopOf('user-1'))
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    translator.handle(userTurn('user-1'))

    translator.handle({ type: 'message', sessionId: 'orca-session', message: cutShort })

    const turn = settledTurn(state.items, 'user-1')
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(providerRows(state.items)).toBe(0)
  })

  it.each([
    ['no terminal reason', cutShort],
    [
      'a failure terminal reason',
      { ...cutShort, terminal_reason: 'api_error', result: 'API Error' }
    ]
  ])('keeps a result with %s and no Stop a failure', (_label, frame) => {
    const state = sinkWithStop(null)
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    translator.handle(userTurn('user-1'))

    translator.handle({ type: 'message', sessionId: 'orca-session', message: frame })

    expect(settledTurn(state.items, 'user-1')).toMatchObject({
      state: 'completed',
      outcome: 'failure'
    })
    expect(providerRows(state.items)).toBe(1)
  })

  it('keeps a turn that finished during the Stop a success', () => {
    const state = sinkWithStop(stopOf('user-1'))
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    translator.handle(userTurn('user-1'))

    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { type: 'result', subtype: 'success', is_error: false }
    })

    expect(settledTurn(state.items, 'user-1')).toMatchObject({ outcome: 'success' })
  })

  it('does not carry a Stop onto the next turn', () => {
    // The Stop named user-1, which a newer send superseded before its result.
    const state = sinkWithStop(stopOf('user-1'))
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    translator.handle(userTurn('user-1'))
    translator.handle(userTurn('user-2'))
    translator.handle({ type: 'message', sessionId: 'orca-session', message: cutShort })
    translator.handle(userTurn('user-3'))
    translator.handle({ type: 'message', sessionId: 'orca-session', message: cutShort })

    expect(settledTurn(state.items, 'user-2')).toMatchObject({ outcome: 'failure' })
    expect(settledTurn(state.items, 'user-3')).toMatchObject({ outcome: 'failure' })
  })

  it('ends the Stop with its turn, so a result after the turn settled reads on its own', () => {
    const state = sinkWithStop(stopOf('user-1'))
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    translator.handle(userTurn('user-1'))
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { type: 'system', subtype: 'session_state_changed', state: 'idle' }
    })

    translator.handle({ type: 'message', sessionId: 'orca-session', message: cutShort })

    expect(providerRows(state.items)).toBe(1)
  })

  it.each(['host-stop', 'evict'] as const)('does not read a %s as the person asking', (reason) => {
    const state = sinkWithStop(stopOf('user-1', reason))
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    translator.handle(userTurn('user-1'))

    translator.handle({ type: 'message', sessionId: 'orca-session', message: cutShort })

    expect(settledTurn(state.items, 'user-1')).toMatchObject({ outcome: 'failure' })
  })
})
