import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  listStructuredProviderSessionOwnership,
  type StructuredProviderSessionOwnership
} from '../native-chat/agent-session-wire/structured-provider-session-ownership'

export function projectStructuredAiVaultSessions(
  result: AiVaultListResult,
  structuredSupported: boolean
): AiVaultListResult {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return result
  }
  const sessions = result.sessions.flatMap((session) => {
    const ownership = findSessionOwnership(session)
    if (!ownership) {
      return [session]
    }
    if (!structuredSupported) {
      return []
    }
    return [
      {
        ...session,
        structuredSession: {
          sessionId: ownership.sessionId,
          workspaceId: ownership.workspaceId
        }
      }
    ]
  })
  return sessions.length === result.sessions.length &&
    sessions.every((row, index) => row === result.sessions[index])
    ? result
    : { ...result, sessions }
}

export function assertLegacyAiVaultResumeAllowed(args: AiVaultPrepareSessionResumeArgs): void {
  const ownership = findResumeOwnership(args)
  if (ownership) {
    refuseLegacyWriter(ownership)
  }
}

export async function assertLegacyAiVaultResumeCommandAllowed(
  command: string,
  ensureHost: () => Promise<void>
): Promise<void> {
  if (!isPotentialStructuredResumeCommand(command)) {
    return
  }
  await ensureHost()
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  for (const ownership of listOwnership()) {
    if (isResumeCommandFor(command, ownership)) {
      refuseLegacyWriter(ownership)
    }
  }
}

function isPotentialStructuredResumeCommand(command: string): boolean {
  return parseResumeInvocation(command) !== null
}

function findSessionOwnership(session: AiVaultSession): StructuredProviderSessionOwnership | null {
  if (session.agent !== 'codex' && session.agent !== 'claude') {
    return null
  }
  return findOwnership(session.agent, session.sessionId)
}

function findResumeOwnership(
  args: AiVaultPrepareSessionResumeArgs
): StructuredProviderSessionOwnership | null {
  if (args.agent !== 'codex' && args.agent !== 'claude') {
    return null
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  const exact = args.sessionId ? findOwnership(args.agent, args.sessionId) : null
  if (exact) {
    return exact
  }
  const fileName = args.filePath.split(/[\\/]/).at(-1) ?? ''
  return (
    listOwnership().find(
      (ownership) =>
        ownership.provider === args.agent && fileName.includes(ownership.providerSessionId)
    ) ?? null
  )
}

function findOwnership(
  provider: 'claude' | 'codex',
  providerSessionId: string
): StructuredProviderSessionOwnership | null {
  return (
    listOwnership().find(
      (ownership) =>
        ownership.provider === provider && ownership.providerSessionId === providerSessionId
    ) ?? null
  )
}

function listOwnership(): StructuredProviderSessionOwnership[] {
  const host = getStructuredAgentSessionHost()
  return host ? listStructuredProviderSessionOwnership(host.deps.store.listRecords()) : []
}

function isResumeCommandFor(
  command: string,
  ownership: StructuredProviderSessionOwnership
): boolean {
  const invocation = parseResumeInvocation(command)
  if (!invocation || invocation.provider !== ownership.provider) {
    return false
  }
  // A target-less resume (--last, --continue, or a bare --resume/-r) may pick
  // any provider session, so it cannot be admitted while one is structured.
  // Only an explicit target that differs from this owned session is safe.
  return invocation.target === null || invocation.target === ownership.providerSessionId
}

type ResumeInvocation = {
  provider: 'codex' | 'claude'
  target: string | null
}

function parseResumeInvocation(command: string): ResumeInvocation | null {
  // Keep this deliberately conservative: shell quoting is normalized only
  // enough to identify executable/flag tokens; an unrecognized shape is not
  // treated as proof that a different session is being resumed.
  const tokens = command.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|[^\s]+/g) ?? []
  const normalized = tokens.map((token) => token.replace(/^['"]|['"]$/g, ''))
  const executableIndex = normalized.findIndex((token) =>
    /(?:^|[\\/])(?:codex|claude)(?:\.exe)?$/i.test(token)
  )
  if (executableIndex === -1) {
    return null
  }
  const provider = /codex(?:\.exe)?$/i.test(normalized[executableIndex]!) ? 'codex' : 'claude'
  const args = normalized.slice(executableIndex + 1)
  // `--continue`/`-c` resume the most recent session and never take an id, so a
  // following token is a prompt, not a target — they are always target-less.
  const targetlessFlags = provider === 'codex' ? [] : ['--continue', '-c']
  const targetlessIndex = args.findIndex((token) => targetlessFlags.includes(token.toLowerCase()))
  if (targetlessIndex !== -1) {
    return { provider, target: null }
  }
  const resumeFlags = provider === 'codex' ? ['resume'] : ['--resume', '-r']
  const inlineIndex = args.findIndex(
    (token) =>
      provider === 'claude' &&
      (token.toLowerCase().startsWith('--resume=') || token.toLowerCase().startsWith('-r='))
  )
  if (inlineIndex !== -1) {
    const target = args[inlineIndex]!.slice(args[inlineIndex]!.indexOf('=') + 1)
    return { provider, target: target.length > 0 ? target : null }
  }
  const markerIndex = args.findIndex((token) => resumeFlags.includes(token.toLowerCase()))
  if (markerIndex === -1) {
    return null
  }
  const candidate = args[markerIndex + 1]
  return {
    provider,
    target: candidate && !candidate.startsWith('-') ? candidate : null
  }
}

function refuseLegacyWriter(ownership: StructuredProviderSessionOwnership): never {
  throw new Error(
    agentSessionLeaseAdmitsWriter(ownership.lease)
      ? 'agent_session_conflict'
      : 'agent_session_ownership_unknown'
  )
}
