import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem,
  type AgentJournalTurnItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { refineAgentJournalQuotaTurnEnd } from '../../agent-session-timeline/agent-journal-turn-failure-revision'
import type { JournalStopEvent } from '../durable-rows/journal-row-schema'
import { createJournalReducerState } from '../projection/journal-reducer'
import { journalLifecycleMutationFitsOneBatch } from '../writing/journal-lifecycle-batch-partition'
import { buildJournalItemRow } from '../writing/journal-row-builders'
import { journalTimelineItemsView } from '../writing/journal-timeline-view'
import { STOP_DECIDES_FAILURE_MS } from './journal-stop-turn-end'

// The in-memory writer's rows for a turn's end after a Stop, the same rule the persisted writer
// applies: its window's edges, Orca's own stops, and the same end written again.
const NOW = 1_800_000_000_000
// The Stop's window, written out: the production constant doesn't exist before the fix.
const WINDOW_MS = 30_000
const TURN = 'provider-turn'
const ITEM = 'turn-item'

const RUNNING: AgentJournalTurnItem = {
  kind: 'turn',
  turnId: TURN,
  state: 'running',
  startedAt: NOW - 60_000
}
const failedAt = (completedAt?: number): AgentJournalTurnItem => ({
  ...RUNNING,
  state: 'completed',
  outcome: 'failure',
  ...(completedAt === undefined ? {} : { completedAt })
})
const stoppedAt = (completedAt: number): AgentJournalTurnItem => ({
  ...RUNNING,
  state: 'interrupted',
  outcome: 'cancellation',
  completedAt
})

/** The body the in-memory writer saves for `end` over `previous`, with a saved Stop. */
function written(
  end: AgentJournalTurnItem,
  stop: { reason: JournalStopEvent['reason']; at?: number } | null,
  previous: AgentJournalTurnItem = RUNNING
) {
  const state = createJournalReducerState('chat-1', 'e')
  state.items.set(ITEM, { itemId: ITEM, revision: 1, sequence: 5, observedAt: NOW, body: previous })
  if (stop) {
    state.queuePauseMarks.latestStop = {
      sequence: 4,
      event: { reason: stop.reason, turnId: TURN, at: stop.at ?? NOW }
    }
  }
  return buildJournalItemRow({
    state,
    itemId: ITEM,
    body: end,
    seq: 6,
    fence: 1,
    ts: NOW,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }).body
}

const PERSON = { reason: 'user-stop' } as const

describe('the window a person’s Stop decides a failure in', () => {
  it('is 30 s', () => {
    expect(STOP_DECIDES_FAILURE_MS).toBe(WINDOW_MS)
  })

  it('holds from the Stop itself to 30 000 ms after it, and no further', () => {
    expect(written(failedAt(NOW), PERSON)).toMatchObject({ outcome: 'cancellation' })
    expect(written(failedAt(NOW + WINDOW_MS), PERSON)).toMatchObject({
      outcome: 'cancellation'
    })
    expect(written(failedAt(NOW + WINDOW_MS + 1), PERSON)).toMatchObject({
      outcome: 'failure'
    })
  })

  it('never applies to Orca’s own stops', () => {
    for (const reason of ['host-stop', 'evict', 'context-clear'] as const) {
      expect(written(failedAt(NOW + 1_000), { reason })).toMatchObject({ outcome: 'failure' })
    }
  })

  it('leaves an end with no verdict as before: the Stop decides it at any time', () => {
    const late = { ...RUNNING, state: 'interrupted' as const, completedAt: NOW + 60_000 }
    expect(written(late, PERSON)).toMatchObject({ outcome: 'cancellation' })
  })
})

describe('the same stopped end written again', () => {
  const previous = stoppedAt(NOW + 1_000)

  it('stays stopped when the provider’s failed completion lands after the Stop’s own end', () => {
    expect(written(failedAt(NOW + 3_000), PERSON, previous)).toMatchObject({
      state: 'interrupted',
      outcome: 'cancellation'
    })
  })

  it('stays stopped when a restore lost the end’s clock', () => {
    expect(written(failedAt(), PERSON, previous)).toMatchObject({ outcome: 'cancellation' })
  })

  it('stays stopped when a restore rounded the end to the second, before the Stop', () => {
    const stop = { reason: 'user-stop', at: NOW + 300 } as const
    expect(written(failedAt(NOW), stop, stoppedAt(NOW + 700))).toMatchObject({
      outcome: 'cancellation'
    })
  })

  it('takes a distinct failure one millisecond past the window, next to a stopped end at its edge', () => {
    expect(
      written(failedAt(NOW + WINDOW_MS + 1), PERSON, stoppedAt(NOW + WINDOW_MS))
    ).toMatchObject({ outcome: 'failure' })
  })

  it('takes a failure from just before the Stop, next to a stopped end just after it', () => {
    expect(written(failedAt(NOW - 500), PERSON, stoppedAt(NOW + 200))).toMatchObject({
      outcome: 'failure'
    })
  })

  it('takes a real failure long after it', () => {
    expect(written(failedAt(NOW + 40_000), PERSON, previous)).toMatchObject({ outcome: 'failure' })
  })
})

describe('a lifecycle batch sizes a failed end as the stopped end it may become', () => {
  it('refuses one only the unwidened failure would fit', () => {
    const fits = (body: AgentJournalTurnItem) =>
      journalLifecycleMutationFitsOneBatch('settle', {
        kind: 'item',
        itemId: ITEM,
        body,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    const padded = (end: AgentJournalTurnItem, length: number) => ({
      ...end,
      userItemId: 'x'.repeat(length)
    })
    // The longest padding a stopped end still fits with.
    let low = 0
    let high = 2_000_000
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (fits(padded(stoppedAt(NOW), middle))) {
        low = middle
      } else {
        high = middle - 1
      }
    }
    expect(fits(padded(failedAt(NOW), low))).toBe(true)
    expect(fits(padded(failedAt(NOW), low + 1))).toBe(false)
  })
})

describe('a usage-limit end a person stopped', () => {
  const identity: AgentJournalItemIdentity = { provider: 'orca', clientMessageId: 'claude-turn' }
  const failureItemId = 'quota-row'
  const quotaRow: AgentJournalRenderItem = {
    itemId: failureItemId,
    revision: 1,
    sequence: 3,
    observedAt: NOW,
    body: {
      kind: 'status',
      tone: 'warning',
      ...agentSessionFailureWords(agentSessionFailureFact('usageLimitReached'), {
        surface: 'row',
        agentName: 'Claude',
        provider: 'claude'
      })
    },
    turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(identity) }
  }
  const refined = (stopDecidesFailure: boolean) => {
    const view = journalTimelineItemsView(
      (key) => (key === failureItemId ? quotaRow : null),
      () => [quotaRow],
      () => true,
      () => stopDecidesFailure
    )
    const lifecycle = { ...RUNNING, state: 'completed' as const, completedAt: NOW + 40_000 }
    return refineAgentJournalQuotaTurnEnd(view, identity, failureItemId, { lifecycle })?.body
  }

  it('is a failure when it ended outside the Stop’s window', () => {
    expect(refined(false)).toMatchObject({ outcome: 'failure' })
  })

  it('is a cancellation inside it', () => {
    expect(refined(true)).toMatchObject({ outcome: 'cancellation' })
  })
})
