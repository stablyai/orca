import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionBackgroundTaskState } from '../../../shared/agent-session-wire'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

function contextWith(
  backgroundTasks: AgentSessionBackgroundTaskState | null
): AgentSessionTurnContext {
  return {
    sessionId: 'session-1',
    journal: {
      snapshot: () => ({ items: [] }),
      submissions: () => []
    },
    adapter: { backgroundTaskState: () => backgroundTasks }
  } as unknown as AgentSessionTurnContext
}

const RECORD = { lease: {} } as unknown as AgentSessionRecord

describe('conversationCommandBlocked background tasks', () => {
  it('admits the command when nothing is being monitored', () => {
    expect(conversationCommandBlocked(contextWith(null), RECORD)).toBeNull()
  })

  it('asks for a stop when the host accepts targeted stops', () => {
    const blocked = conversationCommandBlocked(
      contextWith({ state: 'monitoring', supportsTaskStop: true }),
      RECORD
    )
    expect(blocked).toBe('Stop background tasks before using this command.')
  })

  it('asks for a stop on a host that predates the stop-capability field', () => {
    const blocked = conversationCommandBlocked(contextWith({ state: 'monitoring' }), RECORD)
    expect(blocked).toBe('Stop background tasks before using this command.')
  })

  it('asks the user to wait when the provider exposes no stop at all', () => {
    // Codex: an instruction to stop would name a control that does not exist.
    const blocked = conversationCommandBlocked(
      contextWith({ state: 'monitoring', supportsStopAll: false }),
      RECORD
    )
    expect(blocked).toBe('Wait for background tasks to finish before using this command.')
  })
})
