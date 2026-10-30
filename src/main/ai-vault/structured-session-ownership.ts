import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { agentSessionOwnerObservationIsLive } from '../../shared/agent-session-lease-adjudication'
import { defaultAgentChatLabel } from '../../shared/agent-session/agent-session-chat-label'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { historyRowFallsBackToChatLabel } from '../../shared/structured-chat-row-name'
import type { AiVaultSearchResponse } from '../../shared/ai-vault-search-types'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { ensureStructuredAgentSessionHostUnlessRefused } from '../runtime/structured-agent-session-host-refusal'
import {
  listStructuredProviderSessionOwnership,
  terminalResumeBlocked,
  type StructuredProviderSessionOwnership
} from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import {
  sessionHistoryBinaryNames,
  type StructuredAgentResumeInvocation,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../runtime/structured-agent-runtime-metadata'
import type { StructuredAgentRuntimeMetadata } from '../runtime/structured-agent-runtime-registration-types'
import { commandName, commandProgramIndex, shellCommands } from './shell-command-words'

/** Hide chat-owned rows from clients unable to open that agent’s chat. */
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
    return [{ ...session, ...ownedRow(session.agent, ownership) }]
  })
  return sessions.length === result.sessions.length &&
    sessions.every((row, index) => row === result.sessions[index])
    ? result
    : { ...result, sessions }
}

/** Owned search hits open their chat and omit terminal resume commands, matching history rows. */
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
      return [{ ...owned, ...ownedRow(hit.agent, ownership) }]
    })
  }
}

/** Keep search available when the chat host cannot install; return hits without ownership metadata. */
export async function searchWithStructuredOwners(
  search: Promise<AiVaultSearchResponse>,
  options: {
    ensureHost?: (() => Promise<unknown>) | undefined
    opensChat: StructuredChatOpener
  }
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

function ownedRow(rowAgent: string, ownership: StructuredProviderSessionOwnership) {
  const structuredSession = {
    sessionId: ownership.sessionId,
    workspaceId: ownership.workspaceId
  }
  const title =
    ownership.conversationName ??
    (historyRowFallsBackToChatLabel(rowAgent) ? defaultAgentChatLabel(ownership.provider) : null)
  return title === null ? { structuredSession } : { title, structuredSession }
}

// Build one lookup per projection to avoid scanning all chat records for every row.
function ownershipLookup():
  | ((row: { agent: string; sessionId: string }) => StructuredProviderSessionOwnership | null)
  | null {
  if (!getStructuredAgentSessionHost()) {
    return null
  }
  const byProviderSession = new Map<string, StructuredProviderSessionOwnership>()
  for (const ownership of listOwnership()) {
    const key = `${ownership.provider}\0${ownership.providerSessionId}`
    const kept = byProviderSession.get(key)
    if (!kept || (kept.role !== 'head' && ownership.role === 'head')) {
      byProviderSession.set(key, ownership)
    }
  }
  return (row) => {
    const found = historyRowOwners(row.agent).flatMap(
      (owner) => byProviderSession.get(`${owner}\0${row.sessionId}`) ?? []
    )
    return found.find((ownership) => ownership.role === 'head') ?? found[0] ?? null
  }
}

/** One history row agent can correspond to several chat providers. */
const HISTORY_ROW_OWNERS = new Map<string, StructuredAgentId[]>()
for (const { definition, sessionHistory } of STRUCTURED_AGENT_RUNTIME_METADATA) {
  for (const rowAgent of sessionHistory.rowAgents) {
    HISTORY_ROW_OWNERS.set(rowAgent, [
      ...(HISTORY_ROW_OWNERS.get(rowAgent) ?? []),
      definition.agent
    ])
  }
}

function historyRowOwners(rowAgent: string): readonly StructuredAgentId[] {
  return HISTORY_ROW_OWNERS.get(rowAgent) ?? []
}

export function assertLegacyAiVaultResumeAllowed(args: AiVaultPrepareSessionResumeArgs): void {
  // A fork writes a new conversation, and preparing its home never writes this one.
  const blocking = args.fork ? undefined : resumeOwnerships(args).find(terminalResumeBlocked)
  if (blocking) {
    refuseLegacyWriter(blocking)
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
  await ensureStructuredAgentSessionHostUnlessRefused(ensureHost)
  for (const ownership of listOwnership()) {
    if (
      terminalResumeBlocked(ownership) &&
      invocations.some((invocation) => resumesOwnedSession(invocation, ownership))
    ) {
      refuseLegacyWriter(ownership)
    }
  }
}

export function findResumeOwnership(
  args: Pick<AiVaultPrepareSessionResumeArgs, 'agent' | 'sessionId' | 'filePath'>
): StructuredProviderSessionOwnership | null {
  return resumeOwnerships(args)[0] ?? null
}

/** Every link naming the row, those matched by id first. */
function resumeOwnerships(
  args: Pick<AiVaultPrepareSessionResumeArgs, 'agent' | 'sessionId' | 'filePath'>
): StructuredProviderSessionOwnership[] {
  const owners = new Set(historyRowOwners(args.agent))
  if (owners.size === 0) {
    return []
  }
  const owned = listOwnership().filter((ownership) => owners.has(ownership.provider))
  const fileName = args.filePath.split(/[\\/]/).at(-1) ?? ''
  return [
    ...(args.sessionId
      ? owned.filter((ownership) => ownership.providerSessionId === args.sessionId)
      : []),
    ...owned.filter((ownership) => fileName.includes(ownership.providerSessionId))
  ]
}

function listOwnership(): StructuredProviderSessionOwnership[] {
  const host = getStructuredAgentSessionHost()
  return host ? listStructuredProviderSessionOwnership(host.deps.store.listConversations()) : []
}

function resumesOwnedSession(
  invocation: ResumeInvocation,
  ownership: StructuredProviderSessionOwnership
): boolean {
  if (invocation.provider !== ownership.provider) {
    return false
  }
  // A targetless resume could open any owned session, so require a provably different target.
  if (invocation.target === null) {
    return true
  }
  const matches = invocation.history.resumeTargetMatches ?? sameIdInAnyCase
  return matches(invocation.target, ownership.providerSessionId)
}

function sameIdInAnyCase(target: string, rowSessionId: string): boolean {
  return target.toLowerCase() === rowSessionId.toLowerCase()
}

type ResumeInvocation = StructuredAgentResumeInvocation & {
  provider: StructuredAgentId
  history: StructuredAgentSessionHistory
}

function parseResumeInvocations(command: string): ResumeInvocation[] {
  // One binary can run the chats of several agents; a resume of it is checked against each.
  const binaries = new Map<string, StructuredAgentRuntimeMetadata[]>()
  for (const registration of STRUCTURED_AGENT_RUNTIME_METADATA) {
    for (const name of sessionHistoryBinaryNames(registration.sessionHistory)) {
      binaries.set(name, [...(binaries.get(name) ?? []), registration])
    }
  }
  // Match programs only; agent names in arguments and prompts cannot resume sessions.
  const invocations: ResumeInvocation[] = []
  for (const words of shellCommands(command)) {
    const program = commandProgramIndex(words)
    for (const registration of binaries.get(commandName(words[program] ?? '')) ?? []) {
      const history = registration.sessionHistory
      const invocation = history.parseResumeArgs(words.slice(program + 1))
      if (invocation) {
        invocations.push({
          ...invocation,
          provider: registration.definition.agent,
          history
        })
      }
    }
  }
  return invocations
}

function refuseLegacyWriter(ownership: StructuredProviderSessionOwnership): never {
  throw new Error(
    agentSessionOwnerObservationIsLive(ownership.ownerObservation)
      ? 'agent_session_conflict'
      : 'agent_session_ownership_unknown'
  )
}
