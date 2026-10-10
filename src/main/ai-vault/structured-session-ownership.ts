import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'
import { defaultAgentChatLabel } from '../../shared/agent-session-chat-label'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import type { AiVaultSearchResponse } from '../../shared/ai-vault-search-types'
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
  const owner = ownershipLookup()
  if (!owner) {
    return result
  }
  const sessions = result.sessions.flatMap((session) => {
    const ownership = session.executionHostId === LOCAL_EXECUTION_HOST_ID ? owner(session) : null
    if (!ownership) {
      return [session]
    }
    if (!structuredSupported) {
      return []
    }
    return [{ ...session, ...ownedTitle(ownership) }]
  })
  return sessions.length === result.sessions.length &&
    sessions.every((row, index) => row === result.sessions[index])
    ? result
    : { ...result, sessions }
}

/** Indexed hits name and own a native chat exactly as list rows do; only this host's index can. */
export function projectStructuredAiVaultSearchResponse(
  response: AiVaultSearchResponse
): AiVaultSearchResponse {
  const owner = response.kind === 'results' ? ownershipLookup() : null
  if (!owner || response.kind !== 'results') {
    return response
  }
  return {
    ...response,
    hits: response.hits.map((hit) => {
      const ownership = owner(hit)
      return ownership ? { ...hit, ...ownedTitle(ownership) } : hit
    })
  }
}

/** The hits once the chat host is installed; plain hits if it will not install, since owning and
 *  naming them must never cost the user the search. */
export async function searchWithStructuredOwners(
  search: Promise<AiVaultSearchResponse>,
  ensureHost?: () => Promise<unknown>
): Promise<AiVaultSearchResponse> {
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
  return (await hostReady) ? projectStructuredAiVaultSearchResponse(response) : response
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
  return (row) =>
    row.agent === 'codex' || row.agent === 'claude'
      ? (byProviderSession.get(`${row.agent}\0${row.sessionId}`) ?? null)
      : null
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
  return parseResumeInvocation(command) !== null
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
  // `codex fork` already falls through below: it carries no `resume` marker.
  if (provider === 'claude' && isClaudeForkInvocation(args)) {
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

/** A fork reads the conversation and writes a new one, so it is no second writer. Not when
 *  `--session-id` names the id it writes under, and nothing after `--` is an option. */
function isClaudeForkInvocation(args: readonly string[]): boolean {
  const terminatorIndex = args.indexOf('--')
  const options = (terminatorIndex === -1 ? args : args.slice(0, terminatorIndex)).map((token) =>
    token.toLowerCase()
  )
  return (
    options.includes('--fork-session') &&
    !options.some((token) => token === '--session-id' || token.startsWith('--session-id='))
  )
}

function refuseLegacyWriter(ownership: StructuredProviderSessionOwnership): never {
  throw new Error(
    agentSessionLeaseAdmitsWriter(ownership.lease)
      ? 'agent_session_conflict'
      : 'agent_session_ownership_unknown'
  )
}
