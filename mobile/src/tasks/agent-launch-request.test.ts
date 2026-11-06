import { describe, expect, it } from 'vitest'
import { readAgentLaunchCreateOutcome } from './agent-launch-request'

const FALLBACK_DETAIL =
  "Your default is a structured chat session, but its chat runtime isn't installed on this host (install it from a new chat tab in Orca); started a terminal agent instead."

describe('readAgentLaunchCreateOutcome', () => {
  it('surfaces why a chat default started a terminal', () => {
    const reply = {
      outcome: { kind: 'terminal', handle: 'term_1' },
      worktreeId: 'repo::/w',
      receipt: {
        mode: 'terminal',
        preferred: 'structured',
        reason: 'chat_runtime_not_installed',
        detail: FALLBACK_DETAIL
      }
    }
    expect(readAgentLaunchCreateOutcome(reply)).toEqual({
      worktreeId: 'repo::/w',
      warning: FALLBACK_DETAIL
    })
  })
})
