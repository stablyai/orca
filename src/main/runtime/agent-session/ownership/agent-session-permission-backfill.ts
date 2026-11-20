import type { AgentSessionStoreTransactions } from '../records/agent-session-store-transactions'

/** Backfill once as the chat host installs; legacy chats used their agent's Arguments. */
export function backfillAgentSessionPermissionModes(
  store: AgentSessionStoreTransactions,
  ranWithFullAccess: (provider: string) => boolean
): Promise<void> {
  if (store.readOnly) {
    return Promise.resolve()
  }
  const fullAccess = new Map(
    [...new Set([...store.state.records.values()].map((record) => record.provider))].map(
      (provider) => [provider, ranWithFullAccess(provider)]
    )
  )
  return store.command({ kind: 'permission-backfill', fullAccess })
}
