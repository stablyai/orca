import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { isAgentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { resolveStructuredAgentSessionCreateSource } from './structured-agent-session-create-source'

const PI_HOME: AgentSessionAccountHome = { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.pi' }
const OPENCODE_HOME: AgentSessionAccountHome = { kind: 'opencode', locator: { kind: 'unmanaged' } }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fork reads only the record store from the host, and this one holds no chat.
const HOST = { deps: { store: { getRecord: () => null } } } as unknown as StructuredAgentSessionHost

function source(
  agent: string,
  continues: {
    resumeFrom?: { providerSessionId: string }
    forkFrom?: { sessionId: string; itemId: string }
  },
  selected: AgentSessionAccountHome = PI_HOME,
  host: StructuredAgentSessionHost | null = HOST
) {
  const selectAccountHome = vi.fn(() => selected)
  const resolved = resolveStructuredAgentSessionCreateSource({
    host,
    settings: {},
    agent,
    selfSessionId: 'session-new',
    location: agentSessionRecordFixture().location,
    ...continues,
    selectAccountHome
  })
  return { resolved, selectAccountHome }
}

async function refusalReason(attempt: Promise<unknown>): Promise<string | undefined> {
  const error = await attempt.then(
    () => null,
    (caught: unknown) => caught
  )
  return isAgentSessionRefusalError(error) ? error.refusal.code : undefined
}

describe('what a new chat starts from', () => {
  it.each([
    ['pi', PI_HOME],
    ['opencode', OPENCODE_HOME]
  ])('starts a blank %s chat in the account a fresh chat picks', async (agent, home) => {
    const { resolved, selectAccountHome } = source(agent, {}, home)

    await expect(resolved).resolves.toEqual({ accountHome: home })
    expect(selectAccountHome).toHaveBeenCalledOnce()
  })

  it.each([
    ['a resume', { resumeFrom: { providerSessionId: 'conversation-1' } }],
    ['a fork', { forkFrom: { sessionId: 'pi_parent_chat', itemId: 'row-1' } }]
  ])(
    'refuses %s for an agent with no transcript to continue, before picking an account',
    async (_, continues) => {
      const { resolved, selectAccountHome } = source('pi', continues)

      expect(await refusalReason(resolved)).toBe('structured_agent_session_unsupported')
      expect(selectAccountHome).not.toHaveBeenCalled()
    }
  )

  it('refuses to resume into an account that is not a config directory', async () => {
    const { resolved } = source(
      'claude',
      { resumeFrom: { providerSessionId: 'conversation-1' } },
      OPENCODE_HOME
    )

    expect(await refusalReason(resolved)).toBe('structured_agent_session_unsupported')
  })

  it('refuses a fork where no host holds the chat to copy', async () => {
    const { resolved } = source(
      'codex',
      { forkFrom: { sessionId: 'codex_parent_chat', itemId: 'row-1' } },
      PI_HOME,
      null
    )

    expect(await refusalReason(resolved)).toBe('structured_agent_session_unsupported')
  })
})
