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
  const identity = session.timeline?.turnIdentity(turnId)
  const body =
    identity &&
    (await session.input.events?.journalHistory?.()?.reads.itemBody(agentJournalItemKey(identity)))
  const known = readAgentJournalTurn(body ?? undefined)
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
  if (turnId && (session.queuedModelTurn === turnId || session.activeTurn === turnId)) {
    session.modelQueueRevision++
  }
  if (!turnId || session.queuedModelTurn !== turnId) {
    return
  }
  session.queuedModelTurn = null
  if (session.activeTurn === turnId) {
    session.timeline?.apply({ type: 'activity', text: null })
  }
}
