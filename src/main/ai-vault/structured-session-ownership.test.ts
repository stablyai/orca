import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionLeaseFixture } from '../../shared/agent-session-record.test-fixture'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  assertLegacyAiVaultResumeAllowed,
  assertLegacyAiVaultResumeCommandAllowed,
  OPENS_EVERY_STRUCTURED_CHAT,
  projectStructuredAiVaultSearchResponse,
  projectStructuredAiVaultSessions
} from './structured-session-ownership'
import type { AiVaultSearchHit, AiVaultSearchResponse } from '../../shared/ai-vault-search-types'
import {
  installOwnership,
  listResult,
  PROVIDER_SESSION
} from './structured-session-ownership.test-support'

const OTHER_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'

describe('structured AI Vault ownership', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

  it('hides owned rows from legacy clients and annotates them for capable clients', () => {
    installOwnership()
    const result = listResult()

    expect(projectStructuredAiVaultSessions(result, () => false).sessions).toEqual([])
    expect(
      projectStructuredAiVaultSessions(result, OPENS_EVERY_STRUCTURED_CHAT).sessions[0]
    ).toMatchObject({
      structuredSession: { sessionId: 'session-alpha', workspaceId: 'workspace-1' }
    })
  })

  it('uses the owning record name while leaving an unowned row alone', () => {
    installOwnership({ conversationName: 'auth/login' })
    const result = listResult()
    const unowned = { ...result.sessions[0]!, sessionId: 'different-session', title: 'Original' }
    const projected = projectStructuredAiVaultSessions(
      { ...result, sessions: [...result.sessions, unowned] },
      OPENS_EVERY_STRUCTURED_CHAT
    )
    expect(projected.sessions[0]?.title).toBe('auth/login')
    expect(projected.sessions[1]).toBe(unowned)
  })

  // An owned hit opens its chat, so it carries no terminal resume command for any agent.
  it('names and owns an indexed search hit as its list row is, leaving other hits alone', () => {
    installOwnership({ conversationName: 'auth/login' })
    const { resumeCommand: _resumeCommand, ...plain } = searchHit()
    const other = { ...searchHit(), sessionId: 'different-session', title: 'Original' }
    const response = projectStructuredAiVaultSearchResponse(
      searchResults([searchHit(), other]),
      OPENS_EVERY_STRUCTURED_CHAT
    )
    expect(response.kind === 'results' && response.hits).toEqual([
      {
        ...plain,
        title: 'auth/login',
        structuredSession: { sessionId: 'session-alpha', workspaceId: 'workspace-1' }
      },
      other
    ])
  })

  it('drops an owned hit for a client that cannot open its chat', () => {
    installOwnership()
    const other = { ...searchHit(), sessionId: 'different-session' }
    const response = projectStructuredAiVaultSearchResponse(
      searchResults([searchHit(), other]),
      () => false
    )
    expect(response.kind === 'results' && response.hits).toEqual([other])
  })

  it.each(['claude', 'codex'] as const)(
    'keeps an unnamed %s chat at its ordinary label',
    (provider) => {
      installOwnership({ provider })
      const result = listResult()
      result.sessions = result.sessions.map((session) => ({
        ...session,
        agent: provider,
        title: 'First prompt'
      }))
      expect(
        projectStructuredAiVaultSessions(result, OPENS_EVERY_STRUCTURED_CHAT).sessions[0]?.title
      ).toBe(provider === 'claude' ? 'Claude Chat' : 'Codex Chat')
    }
  )

  it.each(['ssh:remote', 'runtime:paired'] as const)(
    'never applies local ownership to a same-ID %s row',
    (executionHostId) => {
      installOwnership({ conversationName: 'Local name' })
      const local = listResult()
      const remote = {
        ...local.sessions[0]!,
        id: 'remote-row',
        executionHostId,
        title: 'Remote name'
      }
      const merged = { ...local, sessions: [...local.sessions, remote] }
      expect(
        projectStructuredAiVaultSessions(merged, OPENS_EVERY_STRUCTURED_CHAT).sessions[1]
      ).toBe(remote)
      expect(projectStructuredAiVaultSessions(merged, () => false).sessions).toEqual([remote])
    }
  )

  it('derives typed refusals from the single writer predicate for live and proving leases', async () => {
    installOwnership()
    expect(() =>
      assertLegacyAiVaultResumeAllowed({
        agent: 'codex',
        filePath: `/sessions/rollout-${PROVIDER_SESSION}.jsonl`,
        codexHome: null,
        executionHostId: 'local'
      })
    ).toThrow('agent_session_conflict')

    installOwnership({
      lease: agentSessionLeaseFixture({
        handoffStage: 'new-owner-proving',
        claimStatus: 'reserved',
        ownerProcess: null
      })
    })
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `codex resume '${PROVIDER_SESSION}'`,
        async () => undefined
      )
    ).rejects.toThrow('agent_session_ownership_unknown')
  })

  it.each([
    `codex resume --last`,
    `claude --resume`,
    `claude -r`,
    `claude --continue`,
    `claude -c`,
    // `--continue` takes no session id, so the trailing token is a prompt —
    // reading it as a target would admit a writer onto the owned session.
    `claude --continue "keep going"`,
    `claude -c 019fd532-7c11-7a90-b6de-4e1a2c3d5f61`
  ])('refuses resume commands without a provably different target: %s', async (command) => {
    installOwnership(command.startsWith('claude') ? { provider: 'claude' } : {})

    await expect(
      assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)
    ).rejects.toThrow('agent_session_conflict')
  })

  it('allows a resume command that names a different provider session', async () => {
    installOwnership()

    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        'codex resume 019fd532-7c11-7a90-b6de-4e1a2c3d5f61',
        async () => undefined
      )
    ).resolves.toBeUndefined()
  })

  // A fork writes a new conversation, so "Resume in New CLI" on a chat-owned row must pass.
  it.each([
    {
      provider: 'claude' as const,
      command: `claude '--resume' '${PROVIDER_SESSION}' '--fork-session'`
    },
    { provider: 'claude' as const, command: `claude --continue --fork-session` },
    { provider: 'codex' as const, command: `CODEX_HOME=/h codex 'fork' '${PROVIDER_SESSION}'` }
  ])('allows a fork of the owned session: $command', async ({ provider, command }) => {
    installOwnership({ provider })

    await expect(
      assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)
    ).resolves.toBeUndefined()
  })

  it.each([
    // After `--` the flag is prompt text, so Claude resumes the owned session as a writer.
    `claude --resume ${PROVIDER_SESSION} -- --fork-session`,
    // `--session-id` makes the fork write under the id it names.
    `claude --resume ${PROVIDER_SESSION} --fork-session --session-id ${PROVIDER_SESSION}`,
    `claude --resume ${PROVIDER_SESSION} --fork-session --session-id=${PROVIDER_SESSION}`
  ])('refuses a fork flag that does not make a fork: %s', async (command) => {
    installOwnership({ provider: 'claude' })

    await expect(
      assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)
    ).rejects.toThrow('agent_session_conflict')
  })

  it('prepares a fork of the owned session but still refuses a resume of it', () => {
    installOwnership()
    const args = {
      agent: 'codex' as const,
      sessionId: PROVIDER_SESSION,
      filePath: `/sessions/rollout-${PROVIDER_SESSION}.jsonl`,
      codexHome: null,
      executionHostId: 'local' as const
    }

    expect(() => assertLegacyAiVaultResumeAllowed({ ...args, fork: true })).not.toThrow()
    expect(() => assertLegacyAiVaultResumeAllowed(args)).toThrow('agent_session_conflict')
  })
})

describe('Session History ownership read from the agent registration', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

  it('leaves a row and resume of an agent no chat lists under alone', async () => {
    installOwnership({ provider: 'claude' })
    const result = listResult()
    result.sessions = result.sessions.map((session) => ({ ...session, agent: 'gemini' }))

    expect(projectStructuredAiVaultSessions(result, () => false)).toBe(result)
    expect(() =>
      assertLegacyAiVaultResumeAllowed({
        agent: 'gemini',
        sessionId: PROVIDER_SESSION,
        filePath: `/sessions/${PROVIDER_SESSION}.json`,
        codexHome: null,
        executionHostId: 'local'
      })
    ).not.toThrow()
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `gemini --resume ${PROVIDER_SESSION}`,
        async () => undefined
      )
    ).resolves.toBeUndefined()
  })

  // Each agent reads its own binary's tokens: a folder or argument named after another agent no
  // longer hides a Claude or Codex resume (on main the first claude/codex token decided).
  it.each([
    {
      provider: 'claude' as const,
      command: `cd /Users/me/src/codex && claude --resume ${PROVIDER_SESSION}`
    },
    {
      provider: 'claude' as const,
      command: `codex resume ${OTHER_SESSION} && claude -r ${PROVIDER_SESSION}`
    },
    {
      provider: 'codex' as const,
      command: `cd /Users/me/claude && codex resume ${PROVIDER_SESSION}`
    },
    { provider: 'claude' as const, command: `claude --model pi --resume ${PROVIDER_SESSION}` },
    { provider: 'claude' as const, command: `echo pi && claude --resume ${PROVIDER_SESSION}` },
    { provider: 'claude' as const, command: `cd /Users/me/grok && claude -c` },
    { provider: 'codex' as const, command: `cd /Users/me/omp && codex resume --last` }
  ])(
    'refuses an owned resume after another agent is named: $command',
    async ({ provider, command }) => {
      installOwnership({ provider })

      await expect(
        assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)
      ).rejects.toThrow('agent_session_conflict')
    }
  )

  it.each([
    `claude --model pi --resume ${OTHER_SESSION}`,
    `cd /Users/me/opencode && claude --resume ${OTHER_SESSION}`
  ])('allows a different Claude target with another agent named: %s', async (command) => {
    installOwnership({ provider: 'claude' })

    await expect(
      assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)
    ).resolves.toBeUndefined()
  })

  it.each([
    `/usr/local/bin/claude --resume ${PROVIDER_SESSION}`,
    `C:\\bin\\CLAUDE.EXE -r ${PROVIDER_SESSION}`
  ])("recognises the registered binary by its path's last name: %s", async (command) => {
    installOwnership({ provider: 'claude' })

    await expect(
      assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)
    ).rejects.toThrow('agent_session_conflict')
  })
})

function searchHit(): AiVaultSearchHit {
  return {
    agent: 'codex',
    sessionId: PROVIDER_SESSION,
    title: 'First prompt',
    cwd: '/repo',
    branch: null,
    updatedAt: null,
    messageCount: 1,
    score: 1,
    source: { presence: 'present' },
    evidence: null,
    resumeCommand: `codex resume '${PROVIDER_SESSION}'`
  }
}

function searchResults(hits: AiVaultSearchHit[]): AiVaultSearchResponse {
  return {
    kind: 'results',
    hits,
    page: { cursor: null, hasMore: false },
    generation: 1,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false },
    durationMs: 1
  }
}
