import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { AgentSessionConversationView } from '../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionConversationKeys } from '../../runtime/agent-session/records/agent-session-conversation-key-index'
import {
  STRUCTURED_AGENT_RUNTIME_METADATA,
  structuredAgentRuntimeMetadata
} from '../../runtime/agent-session/installation/structured-agent-runtime-metadata'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  listStructuredProviderSessionOwnership,
  type StructuredProviderSessionOwnership
} from '../../native-chat/agent-session-wire/host/structured-provider-session-ownership'

// Each row asks the store's ownership index, so a projection never walks every saved chat.
export function historyRowOwnershipLookup():
  | ((row: { agent: string; sessionId: string }) => StructuredProviderSessionOwnership | null)
  | null {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  const { store } = host.deps
  // A long chain's links can fill a page, so each chat is projected once per projection.
  const projected = new Map<string, Map<string, StructuredProviderSessionOwnership[]>>()
  const ownedBy = (view: AgentSessionConversationView) => {
    let byKey = projected.get(view.sessionId)
    if (!byKey) {
      byKey = Map.groupBy(listStructuredProviderSessionOwnership([view]), ownershipKey)
      projected.set(view.sessionId, byKey)
    }
    return byKey
  }
  return (row) => {
    // Per provider the first head link, else the first link, in listing order.
    const found = historyRowOwners(row.agent).flatMap((owner) => {
      const key = ownershipKey({ provider: owner, providerSessionId: row.sessionId })
      const owned = store
        .conversationsKeyedBy(ownershipKeys, key)
        .flatMap((view) => ownedBy(view).get(key) ?? [])
      return owned.find((ownership) => ownership.role === 'head') ?? owned[0] ?? []
    })
    return found.find((ownership) => ownership.role === 'head') ?? found[0] ?? null
  }
}

export type HistoryRowWithOwner<Row> = {
  row: Row
  ownership: StructuredProviderSessionOwnership | null
}

/** Every conversation a chat held opens and deletes that one chat, so it lists once: its head row, else its first. */
export function oneRowPerChat<Row>(rows: readonly HistoryRowWithOwner<Row>[]): Row[] {
  const kept = new Map<string, { index: number; head: boolean }>()
  rows.forEach(({ ownership }, index) => {
    if (!ownership) {
      return
    }
    const head = ownership.role === 'head'
    const current = kept.get(ownership.sessionId)
    if (!current || (head && !current.head)) {
      kept.set(ownership.sessionId, { index, head })
    }
  })
  return rows.flatMap(({ row, ownership }, index) =>
    !ownership || kept.get(ownership.sessionId)?.index === index ? [row] : []
  )
}

/** Whether a deleted chat held the row's conversation: Orca never lists or resumes it again. */
export function historyRowOfDeletedChat():
  | ((row: { agent: string; sessionId: string }) => boolean)
  | null {
  // Absent on a store opened before any delete could be read.
  const deleted = getStructuredAgentSessionHost()?.deps.store.deletedChats
  if (!deleted) {
    return null
  }
  return (row) =>
    historyRowOwners(row.agent).some((provider) =>
      deleted.hasConversation({ provider, providerSessionId: row.sessionId })
    )
}

const ownershipKey = (ownership: { provider: string; providerSessionId: string }): string =>
  `${ownership.provider}\0${ownership.providerSessionId}`

// Every link of a chat whose agent lists history, as `listStructuredProviderSessionOwnership` keys it.
const ownershipKeys: AgentSessionConversationKeys = ({ provider, providerHandleChain }) => {
  const history = structuredAgentRuntimeMetadata(provider)?.sessionHistory
  return history
    ? providerHandleChain.map((link) =>
        ownershipKey({ provider, providerSessionId: history.rowSessionId(link) })
      )
    : []
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

export function historyRowOwners(rowAgent: string): readonly StructuredAgentId[] {
  return HISTORY_ROW_OWNERS.get(rowAgent) ?? []
}
