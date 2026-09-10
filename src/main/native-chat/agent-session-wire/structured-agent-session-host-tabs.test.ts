import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { listStructuredAgentSessionTabs } from './structured-agent-session-host-tabs'

const sessions = new Map([
  ['named', { params: { location: { workspaceId: 'ws-1' }, provider: 'codex' as const } }],
  ['unnamed', { params: { location: { workspaceId: 'ws-1' }, provider: 'claude' as const } }]
])

describe('listStructuredAgentSessionTabs', () => {
  it('publishes the conversation name a record kept, and omits it where none exists', () => {
    const tabs = listStructuredAgentSessionTabs(sessions, (sessionId) =>
      sessionId === 'named'
        ? ({ conversationName: 'Fix the lease probe' } as AgentSessionRecord)
        : null
    )

    expect(tabs).toEqual([
      { sessionId: 'named', workspaceId: 'ws-1', agent: 'codex', title: 'Fix the lease probe' },
      { sessionId: 'unnamed', workspaceId: 'ws-1', agent: 'claude' }
    ])
  })

  it('reports no titles at all when the caller supplies no record lookup', () => {
    expect(listStructuredAgentSessionTabs(sessions)).toEqual([
      { sessionId: 'named', workspaceId: 'ws-1', agent: 'codex' },
      { sessionId: 'unnamed', workspaceId: 'ws-1', agent: 'claude' }
    ])
  })
})
