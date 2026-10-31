import { describe, expect, it } from 'vitest'
import { structuredPushOccurrence } from './structured-push-identity'
import {
  agentSessionAttentionKey,
  structuredAttentionOrigin,
  type AgentSessionAttentionEdge
} from '../../shared/agent-session-attention'

describe('structured push occurrence', () => {
  it('preserves one host occurrence across forwarding and distinguishes a prompt re-raise', () => {
    const edge: AgentSessionAttentionEdge = {
      type: 'prompt',
      prompt: {
        scope: {
          workspaceId: 'workspace',
          executionHostId: 'local',
          wslDistro: null,
          workspaceKind: 'folder'
        },
        sessionId: 'session',
        promptId: 'prompt',
        raisedAt: 1,
        journalCursor: { epoch: 'journal', sequence: 1 }
      }
    }
    const key = agentSessionAttentionKey(edge)
    const original = structuredPushOccurrence(key, structuredAttentionOrigin(edge))
    expect(original).toHaveLength(43)
    expect(structuredPushOccurrence(key, structuredAttentionOrigin(structuredClone(edge)))).toBe(
      original
    )
    const raised = structuredClone(edge)
    raised.prompt.journalCursor = { epoch: 'journal', sequence: 2 }
    expect(structuredPushOccurrence(key, structuredAttentionOrigin(raised))).not.toBe(original)
    delete raised.prompt.journalCursor
    expect(structuredPushOccurrence(key, structuredAttentionOrigin(raised))).toBeUndefined()
  })
})
