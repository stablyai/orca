import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { restartContinuationId } from './structured-agent-session-restart-continuation-envelope'
import { restartAutoContinuationAllowed } from './structured-agent-session-restart-loop-cap'
import {
  marker,
  NOW,
  SESSION,
  submission
} from './testing/structured-agent-session-restart-resume.test-fixture'

const MINUTE = 60_000

/** The note Orca writes once the agent took a continuation. */
function tookContinuation(at: number, tone?: 'warning'): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({
      provider: 'orca',
      clientMessageId: `restart-continuation:${SESSION}:${at}`
    }),
    revision: 1,
    body: { kind: 'status', text: 'Orca asked this agent to continue', ...(tone ? { tone } : {}) },
    sequence: 1,
    observedAt: at
  }
}

describe('restart auto-continuation cap', () => {
  const offer = marker({ teardownId: 'crash:runtime-4', trigger: 'crash' })

  it('continues a cut at most once', () => {
    const sent = submission(restartContinuationId(offer, 'op', NOW), 'unknown')
    expect(restartAutoContinuationAllowed(offer, { items: [], submissions: [sent] }, NOW)).toBe(
      false
    )
    // A person's own send has the same id shape and is not a continuation.
    const person = submission(`${NOW}-${'a'.repeat(32)}`, 'accepted')
    expect(restartAutoContinuationAllowed(offer, { items: [], submissions: [person] }, NOW)).toBe(
      true
    )
  })

  it('stops after three continuations the agent took within five minutes', () => {
    const took = [4, 3, 2].map((minutes) => tookContinuation(NOW - minutes * MINUTE))
    const allowed = (items: AgentJournalRenderItem[]) =>
      restartAutoContinuationAllowed(offer, { items, submissions: [] }, NOW)
    expect(allowed(took.slice(1))).toBe(true)
    expect(allowed(took)).toBe(false)
    expect(allowed([tookContinuation(NOW - 20 * MINUTE), ...took.slice(1)])).toBe(true)
    expect(allowed([tookContinuation(NOW - MINUTE, 'warning'), ...took.slice(1)])).toBe(true)
  })

  it('counts what crashed runs sent, even when each died before its note', () => {
    // Runs start a minute apart; each sends for the offer of the run before it, which crashed.
    const start = (minutesAgo: number) => NOW - minutesAgo * MINUTE
    const runs = [5, 4, 3, 2].map((minutesAgo, index) => ({
      runtime: `runtime-${index}`,
      startedAt: start(minutesAgo),
      end: 'crash' as const
    }))
    const sentBy = (crashed: number) =>
      submission(
        restartContinuationId(
          marker({ teardownId: `crash:runtime-${crashed}`, trigger: 'crash' }),
          'op',
          runs[crashed + 1].startedAt + 1_000
        ),
        'unknown'
      )
    const history = { runs, thisRunStartedAt: start(1) }
    const allowed = (
      submissions: ReturnType<typeof submission>[],
      items: AgentJournalRenderItem[] = []
    ) => restartAutoContinuationAllowed(offer, { items, submissions }, NOW, history)

    expect(allowed([sentBy(0), sentBy(1), sentBy(2)])).toBe(false)
    expect(allowed([sentBy(1), sentBy(2)])).toBe(true)
    // A run that wrote its note counts once, not twice.
    const noted = [tookContinuation(runs[1].startedAt + 2_000)]
    expect(allowed([sentBy(0), sentBy(1)], noted)).toBe(true)
    // An earlier continuation known only by its note, then two crashed runs that sent without one.
    expect(allowed([sentBy(1), sentBy(2)], noted)).toBe(false)
  })
})
