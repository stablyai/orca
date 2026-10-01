import { describe, expect, it } from 'vitest'
import { structuredAgentSessionShownStatus } from './structured-agent-session-shown-work'
import { childRecord, submission } from './structured-agent-session-restart-resume-test-harness'

describe('whether a session shows as working', () => {
  // The status feed scopes unanswered sends to the lease fence; a stale one would otherwise offer a
  // resume for a chat the sidebar showed idle.
  it('does not count a send left pending under an older lease fence', () => {
    const journal = { items: [], submissions: [submission('msg-1', 'pending')] }
    expect(structuredAgentSessionShownStatus(journal, undefined, 2).state).toBe('done')
    expect(structuredAgentSessionShownStatus(journal, undefined, 1).state).not.toBe('done')
  })

  it('counts a settled lead whose monitor still runs', () => {
    const journal = { items: [], submissions: [] }
    expect(
      structuredAgentSessionShownStatus(
        journal,
        [
          childRecord({
            id: 'watch',
            kind: 'monitor',
            description: 'Watch CI',
            state: 'monitoring'
          })
        ],
        1
      ).state
    ).not.toBe('done')
    expect(structuredAgentSessionShownStatus(journal, [], 1).state).toBe('done')
  })
})
