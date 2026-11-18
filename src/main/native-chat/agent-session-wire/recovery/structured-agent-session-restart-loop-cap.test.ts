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
    const sentBy = (runtime: string, minutesAgo: number) =>
      submission(
        restartContinuationId(
          marker({ teardownId: `crash:${runtime}`, trigger: 'crash' }),
          'op',
          NOW - minutesAgo * MINUTE
        ),
        'unknown'
      )
    const submissions = [sentBy('runtime-1', 3), sentBy('runtime-2', 2), sentBy('runtime-3', 1)]
    const crashes = ['runtime-1', 'runtime-2', 'runtime-3']
    const allowed = (sent: typeof submissions, recentCrashes = crashes) =>
      restartAutoContinuationAllowed(offer, { items: [], submissions: sent }, NOW, recentCrashes)
    expect(allowed(submissions)).toBe(false)
    expect(allowed(submissions, crashes.slice(1))).toBe(true)
    expect(allowed([sentBy('runtime-1', 20), ...submissions.slice(1)])).toBe(true)
  })
})
