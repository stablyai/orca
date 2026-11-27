import type { OrchestrationDb } from './orchestration-db'

/** Whether a Dispatch descends from a bot. This carries bot task guidance without selecting a worker surface. */
export function dispatchHasBotLineage(
  db: OrchestrationDb,
  dispatchId: string,
  isBotChat: (sessionId: string) => boolean
): boolean {
  const seen = new Set<string>()
  const pending = [dispatchId]
  while (pending.length > 0 && seen.size < 100) {
    const id = pending.pop()
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    const context = db.getDispatchContextById(id)
    if (!context) {
      // A paired host receives this trusted stamp from a bot home; a missing unstamped row
      // does not prove that another pending ancestry branch is not bot-rooted.
      if (db.getRemoteDispatchAttachment(id)?.chat_lineage === 1) {
        return true
      }
      continue
    }
    if (context.chat_lineage === 1 || context.bot_lineage === 1) {
      return true
    }
    const session =
      context.creator_orca_session_id ??
      (context.creator_dispatch_id ? null : db.getRun(context.run_id)?.coordinator_orca_session_id)
    if (session && isBotChat(session)) {
      return true
    }
    if (context.creator_dispatch_id) {
      pending.push(context.creator_dispatch_id)
    }
    if (context.retry_of_dispatch_id) {
      pending.push(context.retry_of_dispatch_id)
    }
    if (context.follow_up_of_dispatch_id) {
      pending.push(context.follow_up_of_dispatch_id)
    }
  }
  return false
}
