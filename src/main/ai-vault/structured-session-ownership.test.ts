import { afterEach, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import { parseAiVaultListResult } from './session-list-result-validation'
import { redactForTransport } from '../../shared/ai-vault-search-transport'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  assertLegacyAiVaultResumeAllowed,
  assertLegacyAiVaultResumeCommandAllowed,
  findResumeOwnership,
  OPENS_EVERY_STRUCTURED_CHAT,
  projectStructuredAiVaultSearchResponse,
  projectStructuredAiVaultSessions
} from './structured-session-ownership'
import type { AiVaultSearchHit, AiVaultSearchResponse } from '../../shared/ai-vault-search-types'
import {
  codexChatHolding,
  installChats,
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
        accountHome: agentSessionRecordFixture().accountHome,
        accountWslDistro: null,
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
    'projects %s recorded account evidence through history validation',
    (provider) => {
      const accountHome = {
        variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        path: '/accounts/recorded'
      }
      installOwnership({ provider, accountHome, wslDistro: 'Ubuntu' })
      const result = listResult()
      result.sessions[0]!.agent = provider
      const projected = projectStructuredAiVaultSessions(result, OPENS_EVERY_STRUCTURED_CHAT)
      expect(parseAiVaultListResult(projected).sessions[0]).toMatchObject({
        accountHome,
        accountWslDistro: 'Ubuntu'
      })
      expect(
        parseAiVaultListResult({
          ...projected,
          sessions: [{ ...projected.sessions[0], accountHome: { kind: 'future' } }]
        }).sessions[0]?.accountHome
      ).toBeUndefined()

      installOwnership({
        provider,
        accountHome: { ...accountHome, path: join(homedir(), `.${provider}`) }
      })
      expect(
        projectStructuredAiVaultSessions(result, OPENS_EVERY_STRUCTURED_CHAT).sessions[0]
          ?.accountHome
      ).toBeNull()
      expect(parseAiVaultListResult(result).sessions[0]?.accountHome).toBeUndefined()
    }
  )

  it('keeps the legacy shared Codex home unknown and redacts account homes over relay search', () => {
    installOwnership({
      accountHome: { variable: 'CODEX_HOME', path: resolveOrcaManagedCodexHomePath() }
    })
    expect(
      projectStructuredAiVaultSessions(listResult(), OPENS_EVERY_STRUCTURED_CHAT).sessions[0]
        ?.accountHome
    ).toBeUndefined()
    const accountHome = { variable: 'CODEX_HOME', path: '/accounts/recorded' }
    installOwnership({ accountHome })
    const response = projectStructuredAiVaultSearchResponse(
      searchResults([searchHit()]),
      OPENS_EVERY_STRUCTURED_CHAT
    )
    if (response.kind !== 'results') {
      throw new Error('Expected search results')
    }
    const hit = response.hits[0]!
    expect(redactForTransport(hit, 'ipc').accountHome).toEqual(accountHome)
    expect(redactForTransport(hit, 'relay')).not.toHaveProperty('accountHome')
    expect(redactForTransport(hit, 'relay')).not.toHaveProperty('accountWslDistro')
    const relayed = projectStructuredAiVaultSearchResponse(
      searchResults([searchHit()]),
      OPENS_EVERY_STRUCTURED_CHAT,
      'relay'
    )
    if (relayed.kind !== 'results') {
      throw new Error('Expected search results')
    }
    expect(relayed.hits[0]).not.toHaveProperty('accountHome')
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

  it('names the chat continuing a conversation first, while every link still refuses a terminal', async () => {
    const movedOn = codexChatHolding('session-moved', [PROVIDER_SESSION, OTHER_SESSION])
    const owned = (records: ReturnType<typeof codexChatHolding>[]) => {
      installChats(records)
      return projectStructuredAiVaultSessions(listResult(), OPENS_EVERY_STRUCTURED_CHAT).sessions[0]
        ?.structuredSession?.sessionId
    }
    expect(owned([movedOn, codexChatHolding('session-now', [PROVIDER_SESSION])])).toBe(
      'session-now'
    )
    expect(owned([movedOn])).toBe('session-moved')
    expect(
      findResumeOwnership({ agent: 'codex', sessionId: PROVIDER_SESSION, filePath: '' })
    ).toMatchObject({
      sessionId: 'session-moved',
      role: 'earlier'
    })
    expect(() =>
      assertLegacyAiVaultResumeAllowed({
        agent: 'codex',
        filePath: `/sessions/rollout-${PROVIDER_SESSION}.jsonl`,
        codexHome: null,
        executionHostId: 'local'
      })
    ).toThrow('agent_session_conflict')
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `codex resume ${PROVIDER_SESSION}`,
        async () => undefined
      )
    ).rejects.toThrow('agent_session_conflict')
  })

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
      ownerObservation: agentSessionConversationView(
        agentSessionRecordFixture(
          agentSessionLeaseFixture({
            handoffStage: 'new-owner-proving',
            claimStatus: 'reserved',
            ownerProcess: null
          })
        )
      ).ownerObservation
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
    // --continue takes no id; trailing prompt text must not be mistaken for a different target.
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
    `claude --session-id ${PROVIDER_SESSION} --add-dir ~/src/claude --fork-session --resume ${PROVIDER_SESSION}`,
    `claude --fork-session --resume=${PROVIDER_SESSION} --add-dir ~/x/claude --session-id ${PROVIDER_SESSION}`,
    `claude --resume ${PROVIDER_SESSION} && claude --fork-session -p hi`
  ])('refuses a writer whose own command names claude again: %s', async (command) => {
    installOwnership({ provider: 'claude' })

    await expect(
      assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)
    ).rejects.toThrow('agent_session_conflict')
  })

  it.each(
    ['\\', '`', '^'].flatMap((mark) =>
      ['\n', '\r', '\r\n'].map((lineBreak) => ({ mark, lineBreak }))
    )
  )(
    'reads a command continued with $mark and a $lineBreak line break as one',
    async ({ mark, lineBreak }) => {
      installOwnership({ provider: 'claude' })

      await expect(
        assertLegacyAiVaultResumeCommandAllowed(
          `claude ${mark}${lineBreak}  --resume ${PROVIDER_SESSION}`,
          async () => undefined
        )
      ).rejects.toThrow('agent_session_conflict')
    }
  )

  it.each(['\r', '\r\n'])('reads each %j line as its own Claude command', async (lineBreak) => {
    installOwnership({ provider: 'claude' })

    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `claude --resume ${OTHER_SESSION}${lineBreak}claude --resume ${PROVIDER_SESSION}${lineBreak}`,
        async () => undefined
      )
    ).rejects.toThrow('agent_session_conflict')
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `claude --resume ${OTHER_SESSION}${lineBreak}echo -c${lineBreak}`,
        async () => undefined
      )
    ).resolves.toBeUndefined()
  })

  it('allows a fork whose own command names claude again', async () => {
    installOwnership({ provider: 'claude' })

    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `claude --resume ${PROVIDER_SESSION} --add-dir ~/src/claude --fork-session`,
        async () => undefined
      )
    ).resolves.toBeUndefined()
  })

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
