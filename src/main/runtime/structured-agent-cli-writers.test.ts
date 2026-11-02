import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentProcessVerdict } from '../../shared/agent-process-presence'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../shared/structured-agent-cli-conversation-adoption'
import type { StructuredAgentId } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { assertCliConversationWritersExited } from './structured-agent-cli-writers'

const row: AgentStatusIpcPayload = {
  paneKey: 'source',
  worktreeId: 'workspace',
  connectionId: null,
  agentType: 'claude',
  receivedAt: 1,
  stateStartedAt: 1,
  state: 'done',
  prompt: '',
  providerSession: { key: 'session_id', id: 'conversation' }
}
const conflict = {
  refusal: { code: 'agent_session_conflict', details: { reason: 'conversationHeldElsewhere' } }
}
function check(
  rows: AgentStatusIpcPayload[],
  verdict: AgentProcessVerdict | null,
  current = true,
  agent: StructuredAgentId = 'claude'
) {
  return assertCliConversationWritersExited(
    {
      rows: () => rows,
      observation: () => ({
        current: () => current,
        presence: async () => verdict,
        topology: 'shared'
      })
    },
    agent,
    'conversation'
  )
}

describe('canonical status store conversation admission', () => {
  it.each(Object.keys(CLI_CONVERSATION_ADOPTING_AGENTS))(
    'refuses a verified live %s holder, including shared topology',
    async (agent) => {
      const chats = CLI_CONVERSATION_ADOPTING_AGENTS
      const entry = Object.entries(chats).find(([name]) => name === agent)
      if (!entry) {
        throw new Error('missing agent')
      }
      for (const chat of entry[1]) {
        await expect(
          assertCliConversationWritersExited(
            {
              rows: () => [{ ...row, agentType: agent }],
              observation: () => ({
                current: () => true,
                presence: async () => 'live',
                topology: 'shared'
              })
            },
            chat,
            'conversation'
          )
        ).rejects.toMatchObject(conflict)
      }
    }
  )

  it.each(['exited', 'unverifiable', null] as const)(
    'admits a %s verdict, including a current Codex hook with no recorded process',
    async (verdict) => {
      await expect(check([row], verdict)).resolves.toBeUndefined()
      await expect(
        check(
          [{ ...row, paneKey: 'other:leaf', agentType: 'codex', state: 'working' }],
          verdict,
          true,
          'codex'
        )
      ).resolves.toBeUndefined()
    }
  )

  it('admits absent, structured, foreign-host and other-conversation rows', async () => {
    await expect(check([], 'live')).resolves.toBeUndefined()
    await expect(
      check(
        [
          { ...row, structuredHost: 'owned' },
          { ...row, connectionId: 'ssh' },
          { ...row, providerSession: { key: 'session_id', id: 'another' } }
        ],
        'live'
      )
    ).resolves.toBeUndefined()
  })

  it('drops a replaced observation while a probe is pending, and admits missing observations', async () => {
    await expect(check([row], 'live', false)).resolves.toBeUndefined()
    const observation = vi.fn(() => null)
    await expect(
      assertCliConversationWritersExited(
        { rows: () => [row], observation },
        'claude',
        'conversation'
      )
    ).resolves.toBeUndefined()
  })
})
