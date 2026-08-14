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
  return (
    /\bcodex(?:\.exe)?\b[\s\S]*\bresume\b/i.test(command) ||
    /\bclaude(?:\.exe)?\b[\s\S]*--resume\b/i.test(command)
  )
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
  if (!command.includes(ownership.providerSessionId)) {
    return false
  }
  return ownership.provider === 'codex'
    ? /\bcodex(?:\.exe)?\b[\s\S]*\bresume\b/i.test(command)
    : /\bclaude(?:\.exe)?\b[\s\S]*--resume\b/i.test(command)
}

function refuseLegacyWriter(ownership: StructuredProviderSessionOwnership): never {
  throw new Error(
    agentSessionLeaseAdmitsWriter(ownership.lease)
      ? 'agent_session_conflict'
      : 'agent_session_ownership_unknown'
  )
}
