import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/orca-session-address-prefix'
import {
  isOrcaSessionId,
  parseOrcaSessionAddress,
  type OrcaSessionId
} from '../../../shared/orca-session-address'
import { isTerminalHandle } from '../../../shared/terminal-handle-prefix'
import type { AgentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { AGENT_CONVERSATION_REFUSAL_CODES as CODES } from '../../../shared/agent-conversations/agent-conversation-contracts'
import { lookupOrcaAgentSession } from '../orchestration/mailbox/routing/structured-session-mail-address'
import {
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from '../orchestration/addressing/session-lineage/structured-session-lineage'
import { canonicalOrcaSessionId } from '../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import { AgentConversationRefusal } from './agent-conversation-refusal'

export type ResolvedAgentConversation =
  | {
      kind: 'chat'
      /** The conversation's /clear root, the ID Copy Orca Session ID copies. */
      orcaSessionId: OrcaSessionId
      record: AgentSessionConversationView
      store: AgentSessionRecordReader
    }
  | { kind: 'terminal'; orcaSessionId: OrcaSessionId }

/** One Orca session ID to the conversation it names on this host: chats first, from the chat
 *  store alone, then this host's terminal agent ids. Resolution reads records only; it never
 *  needs, starts or wakes a running agent. */
export async function resolveAgentConversation(
  runtime: { ensureStructuredAgentSessionHost(): Promise<unknown> },
  input: string
): Promise<ResolvedAgentConversation> {
  const text = input.trim()
  if (isTerminalHandle(text)) {
    throw new AgentConversationRefusal(
      CODES.terminalHandle,
      `${text} is a terminal handle, which changes when the terminal restarts. Use \`orca terminal …\` for it, or the agent's \`orca_session_id:\` from \`orca agent list\`.`
    )
  }
  const id = orcaSessionIdOf(text)
  // The chat store opens lazily; installing it reads records and starts no agent.
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  const store = readAgentSessionRecordStore()
  // A provider's own id is matched as typed; only Orca IDs are respelled.
  const asTyped = store ? lookupOrcaAgentSession(store, text) : null
  if (asTyped?.kind === 'provider-id') {
    throw providerIdRefusal(text, [asTyped.orcaSessionId], store)
  }
  const found = store && id ? (id === text ? asTyped : lookupOrcaAgentSession(store, id)) : null
  if (found?.kind === 'found' && store && id) {
    return {
      kind: 'chat',
      orcaSessionId: canonicalOrcaSessionId(id, store),
      record: found.record,
      store
    }
  }
  if (id) {
    const known = await agentHookServer.isTerminalAgentId(id)
    if (known === true) {
      return { kind: 'terminal', orcaSessionId: id }
    }
    if (known === undefined) {
      throw new AgentConversationRefusal(
        CODES.unavailable,
        `Orca can't look up terminal agent IDs right now, so it can't tell whether agent ${id} runs here. Try again in a moment.`
      )
    }
  }
  // A provider's own id (a bare UUID can also pass as an Orca ID) gets the ID to use instead.
  const linked = text ? await agentHookServer.terminalAgentIdsOfProviderSession(text) : []
  if (linked.length > 0) {
    throw providerIdRefusal(text, linked, store)
  }
  throw id
    ? new AgentConversationRefusal(
        CODES.unknown,
        `No agent ${text} on this Orca. If it runs on another host, run this there or add \`--environment <host>\`.`
      )
    : new AgentConversationRefusal(
        CODES.invalidId,
        `${text || 'That'} is not an Orca session ID. Find agents' IDs with \`orca agent list\`, or copy one with Copy Orca Session ID.`
      )
}

/** The Orca ID `text` spells: an `orca_session_id:` address or a bare ID, whose UUID Orca mints
 *  with underscores where a UUID is usually written with hyphens. */
function orcaSessionIdOf(text: string): OrcaSessionId | null {
  const bare = (
    text.startsWith(ORCA_SESSION_ADDRESS_PREFIX)
      ? text.slice(ORCA_SESSION_ADDRESS_PREFIX.length)
      : text
  ).replace(
    /_([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i,
    '_$1_$2_$3_$4_$5'
  )
  return text.startsWith(ORCA_SESSION_ADDRESS_PREFIX)
    ? parseOrcaSessionAddress(`${ORCA_SESSION_ADDRESS_PREFIX}${bare}`)
    : isOrcaSessionId(bare)
      ? bare
      : null
}

function providerIdRefusal(
  given: string,
  orcaSessionIds: readonly string[],
  store: AgentSessionRecordReader | null
): AgentConversationRefusal {
  const addresses = orcaSessionIds.map(
    (id) =>
      `${ORCA_SESSION_ADDRESS_PREFIX}${isOrcaSessionId(id) ? canonicalOrcaSessionId(id, store) : id}`
  )
  return new AgentConversationRefusal(
    CODES.providerId,
    `${given} is the agent's own conversation id, not its Orca session ID. Address it as ${addresses.join(' or ')}.`
  )
}
