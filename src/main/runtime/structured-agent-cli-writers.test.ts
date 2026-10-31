import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentProcessVerdict } from '../../shared/agent-process-presence'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../shared/structured-agent-cli-conversation-adoption'
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
function check(rows: AgentStatusIpcPayload[], verdict: AgentProcessVerdict | null, current = true) {
  return assertCliConversationWritersExited(
    {
      rows: () => rows,
      observation: () => ({
        current: () => current,
        presence: async () => verdict
      })
    },
    'claude',
    'conversation'
  )
}

describe('canonical status store conversation admission', () => {
  it.each(Object.keys(CLI_CONVERSATION_ADOPTING_AGENTS))(
    'refuses a verified live %s holder',
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
                presence: async () => 'live'
              })
            },
            chat,
            'conversation'
          )
        ).rejects.toMatchObject(conflict)
      }
    }
  )

  it.each(['exited', 'unverifiable'] as const)(
    'admits %s without consulting physical jobs or saved notes',
    async (verdict) => {
      await expect(check([row], verdict)).resolves.toBeUndefined()
    }
  )

  it('a current Codex hook without captured process identity is a live holder, while identity-only rows are not', async () => {
    const codex = { ...row, paneKey: 'other:leaf', agentType: 'codex', state: 'working' as const }
    const run = (providerSessionOnly = false) =>
      assertCliConversationWritersExited(
        {
          rows: () => [{ ...codex, providerSessionOnly }],
          observation: () => ({
            current: () => true,
            presence: async () => null
          })
        },
        'codex',
        'conversation'
      )
    await expect(run()).rejects.toMatchObject(conflict)
    await expect(run(true)).resolves.toBeUndefined()
  })

  it('admits absent, ended, structured, foreign-host and other-conversation rows', async () => {
    await expect(check([], 'live')).resolves.toBeUndefined()
    await expect(
      check(
        [
          { ...row, agentPresence: { agent: 'claude', ended: true } },
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
