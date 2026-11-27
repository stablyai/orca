import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  agentSessionAccountHome,
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { acquiredAgentSessionAccount } from '../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/structured/claude-structured-agent-definition'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import { resolveOrcaManagedCodexHomePath } from '../../codex/configuration/homes/codex-home-paths'
import { agentSessionOwnerObservationIsLive } from '../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import { defaultAgentChatLabel } from '../../../shared/agent-session/conversation-naming/agent-session-chat-label'
import type { AiVaultListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { ownedRowLastTurnPreview } from './owned-history-row-content'
import { isCursorAcpSessionRow } from '../../../shared/ai-vault/session-display/cursor-acp-session-path'
import { historyRowFallsBackToChatLabel } from '../../../shared/agent-session/view/structured-chat-row-name'
import type { AiVaultSearchResponse } from '../../../shared/ai-vault/search/ai-vault-search-types'
import {
  redactForTransport,
  type SessionSearchTransport
} from '../../../shared/ai-vault/search/ai-vault-search-transport'
import type { AiVaultPrepareSessionResumeArgs } from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  historyRowOfDeletedChat,
  historyRowOwners,
  historyRowOwnershipLookup,
  oneRowPerChat,
  type HistoryRowWithOwner
} from './history-row-ownership-lookup'
import { ensureStructuredAgentSessionHostUnlessRefused } from '../../runtime/agent-session/installation/structured-agent-session-host-refusal'
import {
  listStructuredProviderSessionOwnership,
  terminalResumeBlocked,
  type StructuredProviderSessionOwnership
} from '../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import {
  sessionHistoryBinaryNames,
  type StructuredAgentResumeInvocation,
  type StructuredAgentSessionHistory
} from '../../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../../runtime/agent-session/installation/structured-agent-runtime-metadata'
import type { StructuredAgentRuntimeMetadata } from '../../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import { commandName, commandProgramIndex, shellCommands } from './shell-command-words'

/** Hide chat-owned rows from clients unable to open that agent’s chat. */
export type StructuredChatOpener = (agent: StructuredAgentId) => boolean

export const OPENS_EVERY_STRUCTURED_CHAT: StructuredChatOpener = () => true

export function projectStructuredAiVaultSessions(
  result: AiVaultListResult,
  opensChat: StructuredChatOpener,
  // Older clients size Show more by row count alone, so they keep a row per conversation.
  listsChatOnce = true
): AiVaultListResult {
  const owner = historyRowOwnershipLookup()
  const deleted = historyRowOfDeletedChat()
  if (!owner) {
    return result
  }
  const rows = result.sessions.flatMap(
    (session): HistoryRowWithOwner<(typeof result.sessions)[number]>[] => {
      const local = session.executionHostId === LOCAL_EXECUTION_HOST_ID
      if (local && deleted?.(session)) {
        return []
      }
      const ownership = local ? owner(session) : null
      if (!ownership) {
        // A chat forgotten since the scan: its ACP session no longer opens anywhere.
        return local && isCursorAcpSessionRow(session) ? [] : [{ row: session, ownership }]
      }
      if (!opensChat(ownership.provider)) {
        return []
      }
      const row = {
        ...session,
        ...ownedRow(session.agent, ownership),
        ...(ownership.role === 'head' && isCursorAcpSessionRow(session)
          ? ownedRowLastTurnPreview(session, ownership.sessionId)
          : null)
      }
      return [{ row, ownership }]
    }
  )
  const sessions = listsChatOnce ? oneRowPerChat(rows) : rows.map(({ row }) => row)
  const hidden = result.sessions.length - sessions.length
  if (hidden === 0 && sessions.every((row, index) => row === result.sessions[index])) {
    return result
  }
  return hidden === 0
    ? { ...result, sessions }
    : { ...result, sessions, hiddenRowCount: (result.hiddenRowCount ?? 0) + hidden }
}

/** Owned search hits open their chat and omit terminal resume commands, matching history rows. */
export function projectStructuredAiVaultSearchResponse(
  response: AiVaultSearchResponse,
  opensChat: StructuredChatOpener,
  transport: SessionSearchTransport = 'ipc'
): AiVaultSearchResponse {
  const owner = response.kind === 'results' ? historyRowOwnershipLookup() : null
  const deleted = historyRowOfDeletedChat()
  if (!owner || response.kind !== 'results') {
    return response
  }
  return {
    ...response,
    hits: oneRowPerChat(
      response.hits.flatMap((hit): HistoryRowWithOwner<(typeof response.hits)[number]>[] => {
        if (deleted?.(hit)) {
          return []
        }
        const ownership = owner(hit)
        if (!ownership) {
          return [{ row: hit, ownership }]
        }
        if (!opensChat(ownership.provider)) {
          return []
        }
        const { resumeCommand: _resumeCommand, ...owned } = hit
        const row = redactForTransport({ ...owned, ...ownedRow(hit.agent, ownership) }, transport)
        return [{ row, ownership }]
      })
    )
  }
}

/** Keep search available when the chat host cannot install; return hits without ownership metadata. */
export async function searchWithStructuredOwners(
  search: Promise<AiVaultSearchResponse>,
  options: {
    ensureHost?: (() => Promise<unknown>) | undefined
    opensChat: StructuredChatOpener
    transport?: SessionSearchTransport
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
    ? projectStructuredAiVaultSearchResponse(response, options.opensChat, options.transport)
    : response
}

function ownedRow(rowAgent: string, ownership: StructuredProviderSessionOwnership) {
  const structuredSession = {
    sessionId: ownership.sessionId,
    workspaceId: ownership.workspaceId
  }
  const account = {
    accountHome: projectedAccountHome(ownership),
    accountWslDistro: ownership.wslDistro
  }
  const title =
    ownership.conversationName ??
    (historyRowFallsBackToChatLabel(rowAgent) ? defaultAgentChatLabel(ownership.provider) : null)
  return title === null
    ? { structuredSession, ...account }
    : { title, structuredSession, ...account }
}

function projectedAccountHome(ownership: StructuredProviderSessionOwnership) {
  const home = acquiredAccountHome(ownership.sessionId) ?? ownership.key.home
  if (!home) {
    return undefined
  }
  if (!isLegacyAgentSessionAccountHome(home)) {
    return home
  }
  if (
    ownership.provider === 'codex' &&
    !ownership.wslDistro &&
    normalizeRuntimePathForComparison(home.path) ===
      normalizeRuntimePathForComparison(resolveOrcaManagedCodexHomePath())
  ) {
    return undefined
  }
  const directory =
    ownership.provider === 'claude' && home.variable === 'CLAUDE_CONFIG_DIR'
      ? '.claude'
      : ownership.provider === 'codex' && home.variable === 'CODEX_HOME'
        ? '.codex'
        : null
  // Only a known native default proves identity; custom and legacy shared homes do not.
  return !ownership.wslDistro &&
    directory &&
    normalizeRuntimePathForComparison(home.path) ===
      normalizeRuntimePathForComparison(join(homedir(), directory))
    ? null
    : home
}

/** The account the host last launched this chat under, when it observed one; the founding home otherwise. */
function acquiredAccountHome(sessionId: string): AgentSessionAccountHome | undefined {
  const store = getStructuredAgentSessionHost()?.deps.store
  const record = store?.getRecord(sessionId)
  const acquired = store && record ? acquiredAgentSessionAccount(record, store.hostId) : null
  return acquired
    ? agentSessionAccountHome(CLAUDE_STRUCTURED_AGENT, acquired.recipe.home)
    : undefined
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
