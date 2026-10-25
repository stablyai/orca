import { newChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import type { AgentSessionStoreTransactions } from '../../agent-session-store-transactions'

/** One transaction as the chat host installs; before modes, chats ran their own agent's Arguments. */
export function backfillAgentSessionPermissionModes(
  store: AgentSessionStoreTransactions,
  ranWithFullAccess: (provider: string) => boolean
): Promise<void> {
  if (store.readOnly) {
    return Promise.resolve()
  }
  return store.transact((draft) => {
    for (const [sessionId, record] of draft.records) {
      if (record.permissionMode !== undefined) {
        continue
      }
      // Temporary: only the dev team's hourly builds saved the mode among options; remove after 1.4.226 ships.
      const { permissionMode: saved, ...options } = record.options ?? {}
      if (saved !== undefined) {
        draft.records.set(sessionId, { ...record, options, permissionMode: saved })
        continue
      }
      const permissionMode = newChatPermissionMode(
        record.provider,
        ranWithFullAccess(record.provider) ? 'full-access' : 'ask'
      )
      if (permissionMode) {
        draft.records.set(sessionId, { ...record, permissionMode })
      }
    }
  })
}
