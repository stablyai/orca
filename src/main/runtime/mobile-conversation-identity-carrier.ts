import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { AgentStatusEntry, AgentType } from '../../shared/agent-status-types'
import {
  resolveCompatibleAgentTypeForOwner,
  type CompatibleAgentOwnerOptions
} from '../../shared/agent-title-owner'

// Why a symbol: JSON drops symbol keys, so only the audience step that folds it can publish it.
const MOBILE_CONVERSATION_IDENTITY_CARRIER = Symbol('mobile-conversation-identity-carrier')

// Why not exported: exported signatures must not name the private key.
type MobileConversationIdentityCarrierBearer = object & {
  readonly [MOBILE_CONVERSATION_IDENTITY_CARRIER]?: AgentStatusEntry
}

/** A new object carrying `carrier` under the private key; enumerable so later spreads keep it. */
export function withMobileConversationIdentityCarrier<T extends object>(
  target: T,
  carrier: AgentStatusEntry
): T {
  return { ...target, [MOBILE_CONVERSATION_IDENTITY_CARRIER]: carrier }
}

/** The carrier a builder fragment or session tab holds, if any. */
export function readMobileConversationIdentityCarrier<T extends object>(
  source: T | null | undefined
): AgentStatusEntry | null {
  const bearer: MobileConversationIdentityCarrierBearer | null | undefined = source
  return bearer?.[MOBILE_CONVERSATION_IDENTITY_CARRIER] ?? null
}

export function stripMobileConversationIdentityCarrier<T extends object>(source: T): T {
  const copy = { ...source }
  Reflect.deleteProperty(copy, MOBILE_CONVERSATION_IDENTITY_CARRIER)
  return copy
}

/** Unknown session provenance disproves nothing; a known one must share the agent's compatible group. */
export function providerSessionMatchesAgent(args: {
  sessionAgent: AgentType | null | undefined
  agent: AgentType | null | undefined
  ownerAgent: AgentType | null | undefined
  ownerOptions: CompatibleAgentOwnerOptions
}): boolean {
  const sessionAgent = resolveCompatibleAgentTypeForOwner(
    args.sessionAgent,
    args.ownerAgent,
    args.ownerOptions
  )
  return !args.agent || !sessionAgent || args.agent === sessionAgent
}

export type MobileConversationIdentityCandidate = {
  providerSession: AgentProviderSessionMetadata
  /** The agent that reported this session, when the store recorded it. */
  sessionAgent: AgentType | null
  /** When the identity was observed; dates the carrier so repeat projections are stable. */
  observedAt: number
  /** The model reported on the same row as `providerSession`. */
  model?: string
  modelSwitchCommand?: 'orca-model'
}

/**
 * The pane's conversation identity as a completion-neutral session boundary: it carries no
 * turn, tool or question facts, so readers that react to completions ignore it.
 */
export function buildMobileConversationIdentityCarrier(args: {
  candidate: MobileConversationIdentityCandidate | null
  ownerAgent: AgentType | null
  ownerOptions: CompatibleAgentOwnerOptions
  paneKey: string
  tabId: string
  terminalTitle: string
  terminalHandle: string | null
  worktreeId: string | null
}): AgentStatusEntry | null {
  const { candidate } = args
  if (!candidate) {
    return null
  }
  // Why: an aged remnant with no launch hint keeps its reporting agent as the owner.
  const agentType = args.ownerAgent ?? candidate.sessionAgent
  if (
    !agentType ||
    !providerSessionMatchesAgent({
      sessionAgent: candidate.sessionAgent,
      agent: agentType,
      ownerAgent: args.ownerAgent,
      ownerOptions: args.ownerOptions
    })
  ) {
    return null
  }
  return {
    state: 'done',
    sessionBoundary: true,
    prompt: '',
    updatedAt: candidate.observedAt,
    stateStartedAt: candidate.observedAt,
    stateHistory: [],
    paneKey: args.paneKey,
    tabId: args.tabId,
    terminalTitle: args.terminalTitle,
    agentType,
    providerSession: candidate.providerSession,
    // Why: the model belongs to the conversation, so a restarted phone's picker needs it too.
    ...(candidate.model ? { model: candidate.model } : {}),
    ...(candidate.modelSwitchCommand ? { modelSwitchCommand: candidate.modelSwitchCommand } : {}),
    ...(args.terminalHandle ? { terminalHandle: args.terminalHandle } : {}),
    ...(args.worktreeId ? { worktreeId: args.worktreeId } : {})
  }
}
