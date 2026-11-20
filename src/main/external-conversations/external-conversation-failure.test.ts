import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureKind } from '../../shared/agent-session/failures/agent-session-failure'
import { connectorFailure } from './external-conversation-failure'

describe('why a connector conversation’s agent couldn’t do what was asked', () => {
  it('puts each failure in the category whose next step it has', () => {
    const category = (kind: AgentSessionFailureKind) => connectorFailure({ kind }, 'codex').category
    expect(category('notSignedIn')).toBe('signed_out')
    expect(category('usageLimitReached')).toBe('usage_limit')
    expect(category('cliMissing')).toBe('not_set_up')
    expect(category('launchFolderMissing')).toBe('folder_missing')
    expect(category('providerExited')).toBe('agent_error')
    expect(connectorFailure(undefined, 'claude')).toMatchObject({
      category: 'agent_error',
      agentName: 'Claude'
    })
  })

  it('carries a usage limit’s reset only as the agent typed it', () => {
    const failure = connectorFailure(
      { kind: 'usageLimitReached', usageLimit: { resetsAt: 1_900_000_000_000 } },
      'codex'
    )
    expect(failure).toMatchObject({
      agentName: 'Codex',
      usageLimit: { resetsAt: 1_900_000_000_000 }
    })
    expect(connectorFailure({ kind: 'usageLimitReached' }, 'codex')).not.toHaveProperty(
      'usageLimit'
    )
  })
})
