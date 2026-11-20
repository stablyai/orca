import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { TraexSession } from './traex-session'
import { traexNonnegativeNumber, traexText } from './traex-protocol'

export async function observeTraexModelQueue(
  session: TraexSession,
  params: Record<string, unknown>
): Promise<void> {
  const turnId = traexText(params.turnId)
  if (!turnId || params.threadId !== session.threadId || session.isCompletedTurn(turnId)) {
    return
  }
  if (params.state === 'ready') {
    clearTraexModelQueue(session, turnId)
    return
  }
  if (
    (params.state !== 'queued' && params.state !== 'waiting') ||
    (session.activeTurn && session.activeTurn !== turnId)
  ) {
    return
  }
  const revision = ++session.modelQueueRevision
  session.pendingQueuedModelTurn = turnId
  const identity = session.timeline?.turnIdentity(turnId)
  let known: ReturnType<typeof readAgentJournalTurn>
  try {
    const body =
      identity &&
      (await session.input.events
        ?.journalHistory?.()
        ?.reads.itemBody(agentJournalItemKey(identity)))
    known = readAgentJournalTurn(body ?? undefined)
  } finally {
    if (revision === session.modelQueueRevision) {
      session.pendingQueuedModelTurn = null
    }
  }
  if (
    revision !== session.modelQueueRevision ||
    session.ended ||
    session.isCompletedTurn(turnId) ||
    (known && known.state !== 'running') ||
    (session.activeTurn && session.activeTurn !== turnId)
  ) {
    return
  }
  session.queuedModelTurn = turnId
  session.activeTurn = turnId
  if (!session.compacting) {
    session.timeline?.apply({ type: 'turn.open', turn: turnId, at: Date.now() })
  }
  const position = traexNonnegativeNumber(params.position)
  session.timeline?.apply({
    type: 'activity',
    text:
      position !== undefined && Number.isSafeInteger(position)
        ? `Queued (position ${position})`
        : 'Queued'
  })
}

export function clearTraexModelQueue(session: TraexSession, turnId: string | null): void {
  if (
    !turnId ||
    session.pendingQueuedModelTurn === turnId ||
    session.queuedModelTurn === turnId ||
    session.activeTurn === turnId
  ) {
    session.modelQueueRevision++
    if (!turnId || session.pendingQueuedModelTurn === turnId) {
      session.pendingQueuedModelTurn = null
    }
  }
  if (turnId && session.queuedModelTurn !== turnId) {
    return
  }
  const queued = session.queuedModelTurn
  session.queuedModelTurn = null
  if (queued && session.activeTurn === queued) {
    session.timeline?.apply({ type: 'activity', text: null })
  }
}
