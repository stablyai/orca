import {
  chatAgentsShareConversations,
  CLI_CONVERSATION_ADOPTING_AGENTS
} from '../../shared/structured-agent-cli-conversation-adoption'
import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { structuredAgentRuntimeMetadata } from '../runtime/structured-agent-runtime-metadata'
import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'

/** One conversation wherever it is named: the agents sharing its ids, its id (null: a targetless
 *  resume that may pick any of the family's), and its account home (null: the namer can't tell). */
export type ConversationKey = {
  family: string
  id: string | null
  home: AgentSessionAccountHome | null
}

const FAMILY_MEMBERS = [...new Set(Object.entries(CLI_CONVERSATION_ADOPTING_AGENTS).flat(2))].sort()

/** Agents that open one conversation's ids (`opencode`, `opencode2`) share one family name. */
export function conversationFamily(agent: string): string {
  return FAMILY_MEMBERS.find((member) => chatAgentsShareConversations(member, agent)) ?? agent
}

export function recordConversationKey(
  record: Pick<AgentSessionRecord, 'provider' | 'accountHome'>,
  link: AgentSessionProviderHandleLink
): ConversationKey | null {
  const history = structuredAgentRuntimeMetadata(record.provider)?.sessionHistory
  return history
    ? {
        family: conversationFamily(record.provider),
        id: history.rowSessionId(link),
        home: record.accountHome
      }
    : null
}

/** A terminal names a conversation by the id its hooks or command carry; its home is unknown. */
export function terminalConversationKey(agent: string, id: string | null): ConversationKey {
  return { family: conversationFamily(agent), id: id?.trim() || null, home: null }
}

export function keysMayMatch(left: ConversationKey, right: ConversationKey): boolean {
  return (
    left.family === right.family &&
    (left.id === null || right.id === null || sameConversationId(left.family, left.id, right.id)) &&
    (left.home === null ||
      right.home === null ||
      agentSessionAccountHomesEqual(left.home, right.home))
  )
}

// A session-file agent's terminal may name the file; Session History lists its file-name id.
function sameConversationId(family: string, left: string, right: string): boolean {
  if (family === 'opencode') {
    return left === right
  }
  const normalize = (id: string) =>
    (/[\\/]/.test(id) ? sessionIdFromFileName(id) : id).toLowerCase()
  return normalize(left) === normalize(right)
}
