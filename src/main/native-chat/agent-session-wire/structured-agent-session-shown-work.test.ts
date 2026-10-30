import { describe, expect, it } from 'vitest'
import { structuredAgentSessionShownStatus } from './structured-agent-session-shown-work'
import { childRecord, submission } from './structured-agent-session-restart-resume-test-harness'

describe('whether a session shows as working', () => {
  // Stale-fence sends must not create restart offers for otherwise idle chats.
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
