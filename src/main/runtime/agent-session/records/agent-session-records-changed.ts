import type { AgentSessionStoreRowWrites } from '../../../native-chat/agent-session-journal/journal-writer-store-row-changes'

type RecordsChangedListener = (sessionIds: readonly string[], tabsChanged: boolean) => void

/** Tells listeners which records a published commit wrote or removed, and whether it changed which
 *  chats have tabs. */
export class AgentSessionRecordsChanged {
  readonly listeners = new Set<RecordsChangedListener>()

  notify(writes: AgentSessionStoreRowWrites): void {
    const changedIds = [...writes.records.upsert.map(([id]) => id), ...writes.records.remove]
    if (changedIds.length === 0 && writes.sessionTabs === null) {
      return
    }
    for (const listener of this.listeners) {
      try {
        listener(changedIds, writes.sessionTabs !== null)
      } catch (error) {
        // The commit is already published; a throw here would fail a write that succeeded.
        console.warn('[agent-session] records-changed listener failed', error)
      }
    }
  }
}
