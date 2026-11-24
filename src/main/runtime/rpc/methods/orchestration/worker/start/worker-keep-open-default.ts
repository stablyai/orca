import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { botOfSession } from '../../../../../../bots/bot-session-tabs'

/** Whether a started worker stays open after it reports when the caller asked nothing. A worker in its
 *  own new workspace is that workspace's chat, so it stays; one a bot's chat started (itself, or through
 *  a worker of its own) closes, since the bot follows that work on its items. */
export function workerKeepOpenByDefault(
  db: OrchestrationDb,
  worktree: string | undefined,
  dispatchId: string,
  isBotChat: (sessionId: string) => boolean
): boolean {
  if (worktree !== 'new-child' && worktree !== 'new-top-level') {
    return false
  }
  return !workerStartedByBot(db, dispatchId, isBotChat)
}

/** The same default for a worker whose Dispatch lives on the server that runs it, decided here from
 *  the same records a local start uses: the calling chat, and the Dispatch of the worker that is
 *  calling (terminal or chat), since that server does not know this host's bots. */
export function coordinatorKeepOpenByDefault(
  db: OrchestrationDb,
  worktree: string | undefined,
  caller: { orcaSessionId: string | null; creatorDispatchId: string | null },
  isBotChat: (sessionId: string) => boolean
): boolean {
  if (worktree !== 'new-child' && worktree !== 'new-top-level') {
    return false
  }
  if (caller.orcaSessionId && isBotChat(caller.orcaSessionId)) {
    return false
  }
  return !(caller.creatorDispatchId && workerStartedByBot(db, caller.creatorDispatchId, isBotChat))
}

// Walks the recorded creators up to the root coordinator, whose session is the Run's when unrecorded.
export function workerStartedByBot(
  db: OrchestrationDb,
  dispatchId: string,
  isBotChat: (sessionId: string) => boolean
): boolean {
  const seen = new Set<string>()
  let id: string | null = dispatchId
  while (id && !seen.has(id) && seen.size < 100) {
    seen.add(id)
    const context = db.getDispatchContextById(id)
    if (!context) {
      return false
    }
    // A paired host receives this trusted stamp from a bot home; it has no local bot record to consult.
    if (context.chat_lineage === 1) {
      return true
    }
    const session =
      context.creator_orca_session_id ??
      (context.creator_dispatch_id ? null : db.getRun(context.run_id)?.coordinator_orca_session_id)
    if (session && isBotChat(session)) {
      return true
    }
    id = context.creator_dispatch_id
  }
  return false
}

/** Tells the CLI whether to keep the worker open when it asked nothing; older CLIs ignore it. */
export function withKeepOpenDefault<T>(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDb' | 'bots'>,
  worktree: string | undefined,
  receipt: T
): T {
  if (!receipt || typeof receipt !== 'object' || !('dispatchId' in receipt)) {
    return receipt
  }
  const { dispatchId } = receipt
  if (typeof dispatchId !== 'string') {
    return receipt
  }
  const keepOpenByDefault = workerKeepOpenByDefault(
    runtime.getOrchestrationDb(),
    worktree,
    dispatchId,
    (sessionId) => botOfSession(runtime.bots, sessionId) !== null
  )
  return { ...receipt, keepOpenByDefault }
}
