import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionMessages } from '../../../../shared/agent-session/view/structured-agent-session-message-projection'

import { DISPATCH_DOUBT_HOST_RESTARTED } from './journal-dispatch-doubt-reasons'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { renderJournalState } from './journal-public-read'
import { buildJournalSubmissionRow, journalRowBase } from '../writing/journal-row-builders'
import type { JournalRow } from '../durable-rows/journal-row-schema'

function journal() {
  const state = createJournalReducerState('session-1', 'epoch-1')
  let seq = 0
  const push = (next: JournalRow): JournalRow => {
    applyJournalRow(state, next)
    return next
  }
  return {
    state,
    submission(clientMessageId: string, handoverRecorded = true) {
      seq += 1
      return push(
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
          ...(handoverRecorded ? { handoverRecorded: true } : {})
        })
      )
    },
    dispatch(
      clientMessageId: string,
      state_: 'pending' | 'rejected' | 'unknown',
      turnScope: AgentJournalTurnScope = AGENT_JOURNAL_THREAD_SCOPE
    ) {
      seq += 1
      return push({
        kind: 'dispatch',
        clientMessageId,
        state: state_,
        providerItemId: null,
        reason:
          state_ === 'rejected'
            ? DISPATCH_REJECTED_HOST_RESTARTED
            : state_ === 'unknown'
              ? DISPATCH_DOUBT_HOST_RESTARTED
              : null,
        ...(state_ === 'rejected' ? { rejection: { kind: 'hostRestarted' } } : {}),
        ...journalRowBase(state.epoch, seq, 1, 1_000 + seq),
        turnScope
      })
    },
    advance(rows: number) {
      seq += rows
      state.lastSequence = seq
    }
  }
}

function placed(state: ReturnType<typeof journal>['state'], clientMessageId: string) {
  const item = state.items.get(agentJournalSubmissionKey(clientMessageId))
  return item && { sequence: item.sequence, observedAt: item.observedAt, scope: item.turnScope }
}

const IN_TURN: AgentJournalTurnScope = { kind: 'turn', turnItemId: 'orca:turn-1' }

describe('a rejected message', () => {
  it('sits at the rejection, out of the turn it was handed into, when it was a steer', () => {
    const { state, submission, dispatch, advance } = journal()
    submission('steer')
    advance(10)
    dispatch('steer', 'pending', IN_TURN)
    expect(placed(state, 'steer')?.scope).toEqual(IN_TURN)
    advance(10)
    dispatch('steer', 'rejected')

    expect(placed(state, 'steer')).toEqual({
      sequence: 23,
      observedAt: 1_023,
      scope: AGENT_JOURNAL_THREAD_SCOPE
    })
  })
})

describe('a message in doubt', () => {
  it('stays where it was handed over, a plain bubble in its turn: it may have reached the agent', () => {
    const { state, submission, dispatch, advance } = journal()
    submission('steer')
    advance(10)
    dispatch('steer', 'pending', IN_TURN)
    advance(10)
    dispatch('steer', 'unknown')

    expect(placed(state, 'steer')).toEqual({ sequence: 12, observedAt: 1_012, scope: IN_TURN })
    const { items, submissions } = renderJournalState(state)
    const drawn = projectStructuredAgentSessionMessages(items, [], submissions).find(
      (message) => message.id === agentJournalSubmissionKey('steer')
    )
    expect(drawn).toBeDefined()
    expect(drawn?.unsent).toBeUndefined()
  })
})
