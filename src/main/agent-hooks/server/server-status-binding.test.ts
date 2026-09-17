import { describe, expect, it } from 'vitest'

import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { resolveAgentStatusBinding } from './server-status-binding'

const binding = {
  runId: 'run-1',
  attachment: { executionId: 'execution-1' },
  role: 'root' as const
}

function event(overrides: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload {
  return {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    source: 'codex',
    connectionId: null,
    payload: { state: 'working', prompt: 'test', agentType: 'codex' },
    ...overrides
  }
}

describe('agent status binding', () => {
  it('retains a verified provider alias when the same owner emits without session metadata', () => {
    const previous = {
      ...event({
        runId: binding.runId,
        executionId: binding.attachment.executionId,
        providerAlias: {
          provider: 'codex' as const,
          sessionKeyKind: 'session_id' as const,
          providerId: 'session-1'
        }
      }),
      receivedAt: 1,
      stateStartedAt: 1
    }
    const resolved = resolveAgentStatusBinding({
      payload: event({ reportedExecutionBinding: { runId: 'run-1', executionId: 'execution-1' } }),
      previousCandidate: previous,
      resolver: () => binding
    })

    expect(resolved.payload.providerAlias).toEqual(previous.providerAlias)
  })
})
