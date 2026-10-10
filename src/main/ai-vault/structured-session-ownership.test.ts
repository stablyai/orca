import { afterEach, describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { StructuredProviderSessionOwnership } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  assertLegacyAiVaultResumeAllowed,
  assertLegacyAiVaultResumeCommandAllowed,
  projectStructuredAiVaultSearchResponse,
  projectStructuredAiVaultSessions
} from './structured-session-ownership'
import type { AiVaultSearchHit } from '../../shared/ai-vault-search-types'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'

const PROVIDER_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

describe('structured AI Vault ownership', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

  it('hides owned rows from legacy clients and annotates them for capable clients', () => {
    installOwnership()
    const result = listResult()

    expect(projectStructuredAiVaultSessions(result, false).sessions).toEqual([])
    expect(projectStructuredAiVaultSessions(result, true).sessions[0]).toMatchObject({
      structuredSession: { sessionId: 'session-alpha', workspaceId: 'workspace-1' }
    })
  })

  it('uses the owning record name while leaving an unowned row alone', () => {
    installOwnership({ conversationName: 'auth/login' })
    const result = listResult()
    const unowned = { ...result.sessions[0]!, sessionId: 'different-session', title: 'Original' }
    const projected = projectStructuredAiVaultSessions(
      { ...result, sessions: [...result.sessions, unowned] },
      true
    )
    expect(projected.sessions[0]?.title).toBe('auth/login')
    expect(projected.sessions[1]).toBe(unowned)
  })

  it('names and owns an indexed search hit as its list row is, leaving other hits alone', () => {
    installOwnership({ conversationName: 'auth/login' })
    const hit: AiVaultSearchHit = {
      agent: 'codex',
      sessionId: PROVIDER_SESSION,
      title: 'First prompt',
      cwd: '/repo',
      branch: null,
      updatedAt: null,
      messageCount: 1,
      score: 1,
      source: { presence: 'present' },
      evidence: null
    }
    const other = { ...hit, sessionId: 'different-session', title: 'Original' }
    const response = projectStructuredAiVaultSearchResponse({
      kind: 'results',
      hits: [hit, other],
      page: { cursor: null, hasMore: false },
      generation: 1,
      truncated: { candidates: false, snippets: 0, query: false, freshness: false },
      durationMs: 1
    })
    expect(response.kind === 'results' && response.hits).toEqual([
      {
        ...hit,
        title: 'auth/login',
        structuredSession: { sessionId: 'session-alpha', workspaceId: 'workspace-1' }
      },
      other
    ])
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
      expect(projectStructuredAiVaultSessions(result, true).sessions[0]?.title).toBe(
        provider === 'claude' ? 'Claude Chat' : 'Codex Chat'
      )
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
      expect(projectStructuredAiVaultSessions(merged, true).sessions[1]).toBe(remote)
      expect(projectStructuredAiVaultSessions(merged, false).sessions).toEqual([remote])
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

function installOwnership(overrides: Partial<StructuredProviderSessionOwnership> = {}): void {
  const ownership: StructuredProviderSessionOwnership = {
    sessionId: 'session-alpha',
    workspaceId: 'workspace-1',
    provider: 'codex',
    providerSessionId: PROVIDER_SESSION,
    lease: agentSessionLeaseFixture(),
    ...overrides
  }
  const record = agentSessionRecordFixture(ownership.lease)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ownership read touches only `deps.store.listRecords`; the rest of the host is never reached.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        listRecords: () => [
          {
            ...record,
            sessionId: ownership.sessionId,
            location: { ...record.location, workspaceId: ownership.workspaceId },
            provider: ownership.provider,
            providerHandleChain: [
              {
                ...record.providerHandleChain[0]!,
                handle:
                  ownership.provider === 'claude'
                    ? claudeProviderHandle(ownership.providerSessionId, null)
                    : codexProviderHandle(ownership.providerSessionId)
              }
            ],
            lease: { ...ownership.lease, sessionId: ownership.sessionId },
            ...(ownership.conversationName ? { conversationName: ownership.conversationName } : {})
          }
        ]
      }
    }
  } as never)
}

function listResult(): AiVaultListResult {
  const session: AiVaultSession = {
    id: `local:codex:${PROVIDER_SESSION}`,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: PROVIDER_SESSION,
    title: 'Owned',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/sessions/rollout-${PROVIDER_SESSION}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-08-11T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume '${PROVIDER_SESSION}'`,
    subagent: null
  }
  return { sessions: [session], issues: [], scannedAt: '2026-08-11T00:00:00.000Z' }
}
