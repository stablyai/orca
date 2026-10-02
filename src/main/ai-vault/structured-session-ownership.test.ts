import { afterEach, describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { StructuredProviderSessionOwnership } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  assertLegacyAiVaultResumeAllowed,
  assertLegacyAiVaultResumeCommandAllowed,
  projectStructuredAiVaultSessions
} from './structured-session-ownership'

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

  it('allows a codex fork of an owned session', async () => {
    installOwnership()
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `codex fork ${PROVIDER_SESSION}`,
        async () => undefined
      )
    ).resolves.toBeUndefined()
  })

  it('allows a claude fork of an owned session', async () => {
    installOwnership({ provider: 'claude' })
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `claude --resume ${PROVIDER_SESSION} --fork-session`,
        async () => undefined
      )
    ).resolves.toBeUndefined()
  })

  it('allows --fork-session before --resume in the same claude invocation', async () => {
    installOwnership({ provider: 'claude' })
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `claude --fork-session --resume ${PROVIDER_SESSION}`,
        async () => undefined
      )
    ).resolves.toBeUndefined()
  })

  it.each([
    `claude --resume ${PROVIDER_SESSION} --fork-session && claude --resume ${PROVIDER_SESSION}`,
    `claude --resume ${PROVIDER_SESSION} --fork-session; claude --resume ${PROVIDER_SESSION}`,
    `claude --resume ${PROVIDER_SESSION} --fork-session||claude --resume ${PROVIDER_SESSION}`,
    `claude --resume ${PROVIDER_SESSION} --fork-session | claude --resume ${PROVIDER_SESSION}`,
    `claude --resume ${PROVIDER_SESSION} --fork-session & claude --resume ${PROVIDER_SESSION}`,
    `claude --resume ${PROVIDER_SESSION} --fork-session\nclaude --resume ${PROVIDER_SESSION}`,
    `claude --resume ${PROVIDER_SESSION} && claude --fork-session`
  ])('refuses a plain resume chained with a fork: %s', async (command) => {
    installOwnership({ provider: 'claude' })
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)
    ).rejects.toThrow('agent_session_conflict')
  })

  it('refuses an owned resume that follows an unrelated command in a chain', async () => {
    installOwnership()
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `codex fork ${PROVIDER_SESSION} && codex resume ${PROVIDER_SESSION}`,
        async () => undefined
      )
    ).rejects.toThrow('agent_session_conflict')
  })

  it('keeps a quoted separator inside one invocation', async () => {
    installOwnership({ provider: 'claude' })
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `claude --resume ${PROVIDER_SESSION} --fork-session "a && b"`,
        async () => undefined
      )
    ).resolves.toBeUndefined()
  })

  it.each([
    `claude --resume ${PROVIDER_SESSION} --fork-session \\" && claude --resume ${PROVIDER_SESSION} \\"`,
    `claude --resume ${PROVIDER_SESSION} --fork-session $(claude --resume ${PROVIDER_SESSION})`,
    `claude --resume ${PROVIDER_SESSION} --fork-session "$(claude --resume ${PROVIDER_SESSION})"`,
    `claude --resume ${PROVIDER_SESSION} --fork-session \`claude --resume ${PROVIDER_SESSION}\``,
    `claude --resume ${PROVIDER_SESSION} --fork-session "\`claude --resume ${PROVIDER_SESSION}\`"`,
    // Bash/zsh ANSI-C quoting: `$'\''` is one literal quote, so the `&&` is live.
    `claude --resume ${PROVIDER_SESSION} --fork-session $'\\'' && claude --resume ${PROVIDER_SESSION} #'`,
    // cmd caret escape: `^"` opens no quote, so the `&&` is live.
    `claude --resume ${PROVIDER_SESSION} --fork-session ^" && claude --resume ${PROVIDER_SESSION} ^"`,
    // cmd and PowerShell close a double quote at `\\"`.
    `claude --resume ${PROVIDER_SESSION} --fork-session "\\" && claude --resume ${PROVIDER_SESSION} \\""`,
    `claude --resume ${PROVIDER_SESSION} --fork-session <(claude --resume ${PROVIDER_SESSION})`,
    `claude --resume ${PROVIDER_SESSION} --fork-session >(claude --resume ${PROVIDER_SESSION})`,
    `claude --resume ${PROVIDER_SESSION} --fork-session && (claude --resume ${PROVIDER_SESSION})`,
    `claude --resume ${PROVIDER_SESSION} --fork-session && eval "claude --resume ${PROVIDER_SESSION}"`,
    `claude --resume ${PROVIDER_SESSION} --fork-session && sh -c 'claude --resume ${PROVIDER_SESSION}'`
  ])('withholds the fork exemption from a command it cannot split: %s', async (command) => {
    installOwnership({ provider: 'claude' })
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)
    ).rejects.toThrow('agent_session_conflict')
  })

  it.each([
    `claude '--model' 'sonnet' '--resume' '${PROVIDER_SESSION}' '--fork-session'`,
    `& 'claude' '--resume' '${PROVIDER_SESSION}' '--fork-session'`,
    // Plain Windows override paths: `\\` is no escape in PowerShell or cmd.
    `C:\\Users\\me\\.local\\bin\\claude.exe '--resume' '${PROVIDER_SESSION}' '--fork-session'`,
    `C:\\Users\\me\\.local\\bin\\claude.exe "--resume" "${PROVIDER_SESSION}" "--fork-session"`,
    `C:\\Program Files\\claude\\claude.exe '--add-dir' 'C:\\Users\\me' '--resume' '${PROVIDER_SESSION}' '--fork-session'`,
    // Substitution syntax inside single quotes is literal text.
    `claude '--append-system-prompt' 'use \`code\` spans' '--resume' '${PROVIDER_SESSION}' '--fork-session'`,
    `claude '--x' 'a$(b)' '--resume' '${PROVIDER_SESSION}' '--fork-session'`,
    `claude '--x' 'a'"\\\\"'b' '--resume' '${PROVIDER_SESSION}' '--fork-session'`,
    `claude '--append-system-prompt' 'don'"'"'t stop' '--resume' '${PROVIDER_SESSION}' '--fork-session'`
  ])('still allows a single Orca-built fork command: %s', async (command) => {
    installOwnership({ provider: 'claude' })
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)
    ).resolves.toBeUndefined()
  })

  it('still refuses a plain claude resume of an owned session', async () => {
    installOwnership({ provider: 'claude' })
    await expect(
      assertLegacyAiVaultResumeCommandAllowed(
        `claude --resume ${PROVIDER_SESSION}`,
        async () => undefined
      )
    ).rejects.toThrow(/agent_session_(conflict|ownership_unknown)/)
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
  // Why: claude handles key off sessionId, codex off threadId; a single shape would silently unmatch one provider.
  const handle: AgentSessionProviderHandle =
    ownership.provider === 'codex'
      ? { provider: 'codex', threadId: ownership.providerSessionId }
      : { provider: 'claude', sessionId: ownership.providerSessionId, leafUuid: null }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock only implements the `deps.store.listRecords` surface this suite reads; the rest of `StructuredAgentSessionHost` is unused.
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
                handle
              }
            ],
            lease: { ...ownership.lease, sessionId: ownership.sessionId }
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
