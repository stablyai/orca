// The user's newest accepted send, read from the journal's submissions without rendering it.

import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'

function submission(
  index: number,
  submittedAt: number,
  dispatchState: AgentJournalSubmission['dispatchState']
): AgentJournalSubmission {
  return {
    clientMessageId: `send-${index}`,
    fence: 1,
    payloadFingerprint: `fingerprint-${index}`,
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt,
    resolvedAt: null
  }
}

/** The key as read from the journal's render: its submissions by `submittedAt` (a stable sort),
 *  then the last one accepted. */
function renderedKey(submissions: readonly AgentJournalSubmission[]): string {
  const rendered = [...submissions].sort((a, b) => a.submittedAt - b.submittedAt)
  return `epoch:${rendered.findLast((entry) => entry.dispatchState === 'accepted')?.clientMessageId ?? ''}`
}

describe('newestAcceptedSendKey', () => {
  it('reads from the submissions in fold order what it reads from the rendered list', () => {
    let seed = 7
    const next = (bound: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % bound
    }
    const states: AgentJournalSubmission['dispatchState'][] = ['accepted', 'pending', 'rejected']
    for (let round = 0; round < 300; round += 1) {
      // Few distinct clocks, so ties are common; fold order is insertion order, not clock order.
      const submissions = Array.from({ length: next(8) }, (_, index) =>
        submission(index, next(4), states[next(states.length)] ?? 'accepted')
      )
      expect(newestAcceptedSendKey('epoch', submissions)).toBe(renderedKey(submissions))
    }
  })

  it('names the later of two accepted sends with the same clock, as the render orders them', () => {
    const submissions = [submission(0, 5, 'accepted'), submission(1, 5, 'accepted')]

    expect(newestAcceptedSendKey('epoch', submissions)).toBe('epoch:send-1')
  })
})
