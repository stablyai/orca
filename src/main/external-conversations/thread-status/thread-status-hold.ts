// Whether something the thread should see first is still on its way: a status line waits for it.
import { cloudConversation } from '../../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../../shared/connectors/external-conversation-link'
import { idOf, type ThreadStatusDeps } from './thread-status-deps'
import type { ThreadStatusWaits } from './thread-status-waits'

// A running turn holds the lines this long, unless it waits on a prompt in the thread.
const RUNNING_TURN_HOLD_MS = 30 * 60_000

type HoldDeps = Pick<ThreadStatusDeps, 'runningTurn' | 'cloud' | 'answerPending'>

/** What holds a line that is known without waiting, so it can be asked again just before a send. */
export function threadStatusHeldNow(
  deps: HoldDeps,
  waits: ThreadStatusWaits,
  link: ExternalConversationLink,
  /** The pane's latest heard turn end, when known. */
  turnId: number | null,
  now: number
): boolean {
  if (waits.settlingNow(link.paneKey)) {
    return true
  }
  const running = deps.runningTurn(link.paneKey)
  if (running !== null && (now - running < RUNNING_TURN_HOLD_MS || waits.promptOpen(idOf(link)))) {
    return true
  }
  if (turnId === null) {
    return false
  }
  const conversation = cloudConversation(link)
  if (conversation && deps.cloud()?.turnEndPending?.(conversation, turnId) === true) {
    return true
  }
  // An owner's failed mirror post still holds that turn's answer.
  return (link.mirrorHeld ?? []).some(
    ({ event }) =>
      typeof event === 'object' && event !== null && 'turnId' in event && event.turnId === turnId
  )
}

/** Whether the reply outbox still holds the turn's answer; a read that fails holds the line rather
 *  than let it go before the answer. */
export async function threadStatusAnswerHeld(
  deps: HoldDeps,
  link: ExternalConversationLink,
  turnId: number | null
): Promise<boolean> {
  if (turnId === null || !deps.answerPending) {
    return false
  }
  return await deps.answerPending(link, turnId).then(
    (unsent) => unsent,
    () => true
  )
}

/** Which link, pane and turn an answer read was for: a result for another turn says nothing. */
export function answerReadKey(link: ExternalConversationLink, turnId: number | null): string {
  return JSON.stringify([link.source, link.externalId, link.sessionId, link.paneKey, turnId])
}
