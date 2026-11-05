import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { OrchestrationDb } from '../../orchestration/db'
import { readStructuredLineageJournalPage } from '../../orchestration/structured-worker-journal-page'
import { requireRunningStructuredWorker } from '../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import { chatAssigneeJournal } from './orchestration-chat-assignee-journal'
import { resolveStructuredWorkerForDispatch } from './orchestration-structured-worker-lifecycle'

/** A live structured worker's whole journal, unclipped, for in-process owners; null when it is not one. */
export async function readStructuredWorkerJournalMessages(
  db: OrchestrationDb,
  dispatchId: string
): Promise<NativeChatMessage[] | null> {
  const source =
    resolveStructuredWorkerForDispatch(db, dispatchId) ??
    chatAssigneeJournal(db, dispatchId)?.source
  if (!source) {
    return null
  }
  const page = await readStructuredLineageJournalPage(
    requireRunningStructuredWorker(source).lineage
  )
  return page ? projectStructuredItemsToNativeChat(page.items) : null
}
