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
  return !startedForBot(db, dispatchId, isBotChat)
}

/** The same default for a worker whose Dispatch lives on the server that runs it: decided here, from the
 *  coordinator (a bot's chat, or a worker under one), since that server does not know this host's bots. */
export function coordinatorKeepOpenByDefault(
  db: OrchestrationDb,
  worktree: string | undefined,
  coordinator: {
    terminalHandle: string | null
    paneKey: string | null
    orcaSessionId: string | null
  } | null,
  isBotChat: (sessionId: string) => boolean
): boolean {
  if (worktree !== 'new-child' && worktree !== 'new-top-level') {
    return false
  }
  if (coordinator?.orcaSessionId && isBotChat(coordinator.orcaSessionId)) {
    return false
  }
  const own = coordinator?.terminalHandle
    ? db.getActiveDispatchForTerminal(coordinator.terminalHandle, coordinator.paneKey ?? undefined)
    : undefined
  return !(own && startedForBot(db, own.id, isBotChat))
}

// Walks the recorded creators up to the root coordinator, whose session is the Run's when unrecorded.
function startedForBot(
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
