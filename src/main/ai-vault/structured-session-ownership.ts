import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'
import { defaultAgentChatLabel } from '../../shared/agent-session-chat-label'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import type { AiVaultSearchResponse } from '../../shared/ai-vault-search-types'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { ensureStructuredAgentSessionHostUnlessRefused } from '../runtime/structured-agent-session-host-refusal'
import type { StructuredProviderSessionOwnership } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import { listStructuredSessionHistoryOwnership } from '../runtime/structured-agent-session-history-ownership'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import {
  sessionHistoryBinaryNames,
  type StructuredAgentResumeInvocation,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  type StructuredAgentRuntimeRegistration
} from '../runtime/structured-agent-runtime-registrations'

/** Whether the client a projection answers opens a chat of this agent from its history row. A row
 *  owned by a chat it cannot open is hidden from it: resuming that row in a terminal is refused. */
export type StructuredChatOpener = (agent: StructuredAgentId) => boolean

export const OPENS_EVERY_STRUCTURED_CHAT: StructuredChatOpener = () => true

export function projectStructuredAiVaultSessions(
  result: AiVaultListResult,
  opensChat: StructuredChatOpener
): AiVaultListResult {
  const owner = ownershipLookup()
  if (!owner) {
    return result
  }
  const sessions = result.sessions.flatMap((session) => {
    const ownership = session.executionHostId === LOCAL_EXECUTION_HOST_ID ? owner(session) : null
    if (!ownership) {
      return [session]
    }
    if (!opensChat(ownership.provider)) {
      return []
    }
    return [{ ...session, ...ownedTitle(ownership) }]
  })
  return sessions.length === result.sessions.length &&
    sessions.every((row, index) => row === result.sessions[index])
    ? result
    : { ...result, sessions }
}

/** Indexed hits name and own a native chat exactly as list rows do; only this host's index can.
 *  An owned hit opens its chat, so it carries no terminal resume command. */
export function projectStructuredAiVaultSearchResponse(
  response: AiVaultSearchResponse,
  opensChat: StructuredChatOpener
): AiVaultSearchResponse {
  const owner = response.kind === 'results' ? ownershipLookup() : null
  if (!owner || response.kind !== 'results') {
    return response
  }
  return {
    ...response,
    hits: response.hits.flatMap((hit) => {
      const ownership = owner(hit)
      if (!ownership) {
        return [hit]
      }
      if (!opensChat(ownership.provider)) {
        return []
      }
      const { resumeCommand: _resumeCommand, ...owned } = hit
      return [{ ...owned, ...ownedTitle(ownership) }]
    })
  }
}

/** The hits once the chat host is installed; plain hits if it will not install, since owning and
 *  naming them must never cost the user the search. */
export async function searchWithStructuredOwners(
  search: Promise<AiVaultSearchResponse>,
  options: { ensureHost?: (() => Promise<unknown>) | undefined; opensChat: StructuredChatOpener }
): Promise<AiVaultSearchResponse> {
  const { ensureHost } = options
  const hostReady = ensureHost
    ? ensureStructuredAgentSessionHostUnlessRefused(ensureHost).then(
        () => true,
        (error: unknown) => {
          console.warn('[ai-vault-search] returning hits without native chat owners', error)
          return false
        }
      )
    : true
  const response = await search
  return (await hostReady)
    ? projectStructuredAiVaultSearchResponse(response, options.opensChat)
    : response
}

function ownedTitle(ownership: StructuredProviderSessionOwnership) {
  return {
    title: ownership.conversationName ?? defaultAgentChatLabel(ownership.provider),
    structuredSession: { sessionId: ownership.sessionId, workspaceId: ownership.workspaceId }
  }
}

/** One index per projection: a list holds hundreds of rows, each once searched every record. */
function ownershipLookup():
  | ((row: { agent: string; sessionId: string }) => StructuredProviderSessionOwnership | null)
  | null {
  if (!getStructuredAgentSessionHost()) {
    return null
  }
  const byProviderSession = new Map<string, StructuredProviderSessionOwnership>()
  for (const ownership of listOwnership()) {
    const key = `${ownership.provider}\0${ownership.providerSessionId}`
    if (!byProviderSession.has(key)) {
      byProviderSession.set(key, ownership)
    }
  }
  return (row) => {
    const owner = historyRowOwner(row.agent)
    return owner ? (byProviderSession.get(`${owner}\0${row.sessionId}`) ?? null) : null
  }
}

/** The agent whose chats own history rows listed under `rowAgent`; null when none does. */
function historyRowOwner(rowAgent: string): StructuredAgentId | null {
  return (
    STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.find(({ sessionHistory }) =>
      sessionHistory?.rowAgents.some((agent) => agent === rowAgent)
    )?.definition.agent ?? null
  )
}

export function assertLegacyAiVaultResumeAllowed(args: AiVaultPrepareSessionResumeArgs): void {
  // A fork writes a new conversation, and preparing its home never writes this one.
  const ownership = args.fork ? null : findResumeOwnership(args)
  if (ownership) {
    refuseLegacyWriter(ownership)
  }
}

export async function assertLegacyAiVaultResumeCommandAllowed(
  command: string,
  ensureHost: () => Promise<void>
): Promise<void> {
  const invocations = parseResumeInvocations(command)
  if (invocations.length === 0) {
    return
  }
  // A terminal command is not a chat: with chats refused here there is no ownership to check.
  await ensureStructuredAgentSessionHostUnlessRefused(ensureHost)
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  for (const ownership of listOwnership()) {
    if (invocations.some((invocation) => resumesOwnedSession(invocation, ownership))) {
      refuseLegacyWriter(ownership)
    }
  }
}

function findResumeOwnership(
  args: AiVaultPrepareSessionResumeArgs
): StructuredProviderSessionOwnership | null {
  const owner = historyRowOwner(args.agent)
  if (!owner) {
    return null
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  const exact = args.sessionId ? findOwnership(owner, args.sessionId) : null
  if (exact) {
    return exact
  }
  const fileName = args.filePath.split(/[\\/]/).at(-1) ?? ''
  return (
    listOwnership().find(
      (ownership) => ownership.provider === owner && fileName.includes(ownership.providerSessionId)
    ) ?? null
  )
}

function findOwnership(
  provider: StructuredAgentId,
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
  return host ? listStructuredSessionHistoryOwnership(host.deps.store.listRecords()) : []
}

function resumesOwnedSession(
  invocation: ResumeInvocation,
  ownership: StructuredProviderSessionOwnership
): boolean {
  if (invocation.provider !== ownership.provider) {
    return false
  }
  // A target-less resume (--last, --continue, or a bare --resume/-r) may pick
  // any provider session, so it cannot be admitted while one is structured.
  // Only an explicit target that names a different session is safe.
  if (invocation.target === null) {
    return true
  }
  const matches = invocation.history.resumeTargetMatches
  return matches
    ? matches(invocation.target, ownership.providerSessionId)
    : invocation.target === ownership.providerSessionId
}

type ResumeInvocation = StructuredAgentResumeInvocation & {
  provider: StructuredAgentId
  history: StructuredAgentSessionHistory
}

// A line break ends a shell command as `;` does, so the tokenizer keeps it as a token. A PTY's
// Enter sends a bare `\r`.
const LINE_BREAKS = new Set(['\r\n', '\r', '\n'])
const SHELL_COMMAND_SEPARATORS = new Set(['&&', '||', ';', '|', '&', ...LINE_BREAKS])

function parseResumeInvocations(command: string): ResumeInvocation[] {
  // Keep this deliberately conservative: shell quoting is normalized only
  // enough to identify executable/flag tokens; an unrecognized shape is not
  // treated as proof that a different session is being resumed.
  const tokens = command.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\r\n|\r|\n|[^\s]+/g) ?? []
  const normalized = tokens.map((token) => token.replace(/^['"]|['"]$/g, ''))
  const binaries = new Map<string, StructuredAgentRuntimeRegistration>()
  for (const registration of STRUCTURED_AGENT_RUNTIME_REGISTRATIONS) {
    for (const name of registration.sessionHistory
      ? sessionHistoryBinaryNames(registration.sessionHistory)
      : []) {
      binaries.set(name, registration)
    }
  }
  // Each shell command is read alone: in it, each agent reads its arguments from its own first
  // binary token, so another agent's name earlier (`claude --model pi -r x`) never hides it.
  const invocations: ResumeInvocation[] = []
  let firstMentions = new Map<StructuredAgentRuntimeRegistration, number>()
  const readCommand = (end: number) => {
    for (const [registration, mention] of firstMentions) {
      const history = registration.sessionHistory
      const invocation = history?.parseResumeArgs(normalized.slice(mention + 1, end))
      if (history && invocation) {
        invocations.push({ ...invocation, provider: registration.definition.agent, history })
      }
    }
    firstMentions = new Map()
  }
  for (const [index, token] of normalized.entries()) {
    // A quoted operator is an argument, so separators are read before quotes are stripped.
    if (SHELL_COMMAND_SEPARATORS.has(tokens[index]!) && !continuesLine(tokens, index)) {
      readCommand(index)
      continue
    }
    const name = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1)
    const registration = binaries.get(name.toLowerCase())
    if (registration && !firstMentions.has(registration)) {
      firstMentions.set(registration, index)
    }
  }
  readCommand(tokens.length)
  return invocations
}

/** A line break after a line-continuation mark (POSIX `\`, PowerShell `` ` ``, cmd `^`) is inside
 *  one command. */
function continuesLine(tokens: readonly string[], index: number): boolean {
  return LINE_BREAKS.has(tokens[index]!) && /[\\`^]$/.test(tokens[index - 1] ?? '')
}

function refuseLegacyWriter(ownership: StructuredProviderSessionOwnership): never {
  throw new Error(
    agentSessionLeaseAdmitsWriter(ownership.lease)
      ? 'agent_session_conflict'
      : 'agent_session_ownership_unknown'
  )
}
