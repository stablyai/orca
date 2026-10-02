import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { ensureStructuredAgentSessionHostUnlessRefused } from '../runtime/structured-agent-session-host-refusal'
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
  // A terminal command is not a chat: with chats refused here there is no ownership to check.
  await ensureStructuredAgentSessionHostUnlessRefused(ensureHost)
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
  return parseResumeInvocations(command).length > 0
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
  // A target-less resume (--last, --continue, or a bare --resume/-r) may pick
  // any provider session, so it cannot be admitted while one is structured.
  // Only an explicit target that differs from this owned session is safe.
  return parseResumeInvocations(command).some(
    (invocation) =>
      invocation.provider === ownership.provider &&
      (invocation.target === null || invocation.target === ownership.providerSessionId)
  )
}

type ResumeInvocation = {
  provider: 'codex' | 'claude'
  target: string | null
}

type ShellInvocations = {
  segments: string[]
  /** Syntax whose meaning differs across POSIX, PowerShell and cmd, so the split may be wrong. */
  unmodelable: boolean
}

const QUOTE_OR_SEPARATOR = new Set(['"', "'", '`', ';', '&', '|', '\n', '\r'])

// Why: these characters end an invocation in at least one shell Orca launches into.
function isSeparator(char: string): boolean {
  return char === ';' || char === '&' || char === '|' || char === '\n' || char === '\r'
}

// Why: a flag only describes its own invocation, so `fork && plain resume` must not share one exemption.
function splitShellInvocations(command: string): ShellInvocations {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let unmodelable = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    const next = command[index + 1]
    // Why: substitution runs a hidden command; only single quotes make it literal everywhere.
    if (quote !== "'" && (char === '`' || (char === '$' && next === '('))) {
      unmodelable = true
    }
    if (quote === '"') {
      if (char === '\\' && next !== undefined) {
        // Why: POSIX keeps `\"` inside the string; cmd and PowerShell close the string there.
        unmodelable ||= next === '"'
        current += char + next
        index++
        continue
      }
      quote = char === '"' ? null : quote
      current += char
      continue
    }
    if (quote === "'") {
      quote = char === "'" ? null : quote
      current += char
      continue
    }
    // Why: `\` escapes only in POSIX and `^` only in cmd, so before a quote or separator the shells
    // disagree; before anything else (`C:\Users`) every shell reads it literally.
    if ((char === '\\' || char === '^') && (next === undefined || QUOTE_OR_SEPARATOR.has(next))) {
      unmodelable = true
    }
    // Why: ANSI-C `$'…'` takes `\'` as a literal quote, and `<(`/`>(` run a hidden command.
    if ((char === '$' && next === "'") || ((char === '<' || char === '>') && next === '(')) {
      unmodelable = true
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (isSeparator(char)) {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  // Why: an unterminated quote ends differently per shell.
  return { segments, unmodelable: unmodelable || quote !== null }
}

function parseResumeInvocations(command: string): ResumeInvocation[] {
  const { segments, unmodelable } = splitShellInvocations(command)
  // Why: Orca's own fork is one invocation; a chain can hide a resume (`eval`, `sh -c`, `( … )`).
  const single = segments.filter((segment) => segment.trim().length > 0).length <= 1
  const honourForkSession = single && !unmodelable
  // Why: an untrusted split also reads the whole line, with no fork exemption, as before forks existed.
  const candidates = honourForkSession ? segments : [...segments, command]
  return candidates.flatMap((segment) => {
    const invocation = parseResumeInvocation(segment, { honourForkSession })
    return invocation ? [invocation] : []
  })
}

function parseResumeInvocation(
  command: string,
  options: { honourForkSession: boolean }
): ResumeInvocation | null {
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
  // Why: --fork-session resumes into a new session id, so it never writes the named session.
  if (
    options.honourForkSession &&
    provider === 'claude' &&
    args.some((token) => token.toLowerCase() === '--fork-session')
  ) {
    return null
  }
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
