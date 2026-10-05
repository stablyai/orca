// A rejected message sits where it was rejected, in no turn: queued, handed over or sent directly.
// One in doubt stays where it was: it may have reached the agent.

import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import { DISPATCH_DOUBT_HOST_RESTARTED } from './journal-dispatch-doubt-reasons'
import { applyJournalRow, createJournalReducerState, renderJournalState } from './journal-reducer'
import { buildJournalSubmissionRow, journalRowBase } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'

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
    /** Other work between the send and its settlement, as a turn running ahead of it would write. */
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
  it('sits at the rejection, in no turn, when it was queued', () => {
    const { state, submission, dispatch, advance } = journal()
    submission('waiting')
    advance(300)
    dispatch('waiting', 'rejected')

    expect(placed(state, 'waiting')).toEqual({
      sequence: 302,
      observedAt: 1_302,
      scope: AGENT_JOURNAL_THREAD_SCOPE
    })
  })

  it('reaches a subscriber at the tail, so the newest page holds it', () => {
    const { state, submission, dispatch, advance } = journal()
    submission('waiting')
    advance(300)
    const rejection = dispatch('waiting', 'rejected')

    const projected = projectJournalBatch({
      rows: [rejection],
      snapshot: renderJournalState(state),
      afterSequence: 301
    })
    expect(projected.ok && projected.batch.items.map((item) => item.sequence)).toEqual([302])
    expect(renderJournalState(state).items.at(-1)?.itemId).toBe(
      agentJournalSubmissionKey('waiting')
    )
  })

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

  it('sits at the rejection when it was sent directly', () => {
    const { state, submission, dispatch, advance } = journal()
    submission('direct', false)
    advance(10)
    dispatch('direct', 'rejected')

    expect(placed(state, 'direct')?.sequence).toBe(12)
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
    const drawn = projectStructuredAgentSessionMessages(items, [], submissions, {
      rejectedInPlace: true
    }).find((message) => message.id === agentJournalSubmissionKey('steer'))
    expect(drawn).toBeDefined()
    expect(drawn?.unsent).toBeUndefined()
  })
})
