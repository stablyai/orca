import { afterEach, describe, expect, it } from 'vitest'
import { resolveOrcaManagedCodexHomePath } from '../codex/configuration/homes/codex-home-paths'
import { redactForTransport } from '../../shared/ai-vault/search/ai-vault-search-transport'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  assertLegacyAiVaultResumeCommandAllowed,
  OPENS_EVERY_STRUCTURED_CHAT,
  projectStructuredAiVaultSearchResponse,
  projectStructuredAiVaultSessions
} from './structured-session-ownership'
import type {
  AiVaultSearchHit,
  AiVaultSearchResponse
} from '../../shared/ai-vault/search/ai-vault-search-types'
import {
  installOwnership,
  listResult,
  PROVIDER_SESSION
} from './structured-session-ownership.test-support'

const OTHER_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'

describe('structured AI Vault ownership', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

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
})

describe('Session History ownership read from the agent registration', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

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
