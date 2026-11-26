// Whether something the thread should see first is still on its way: a status line waits for it.
import { cloudConversation } from '../../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../../shared/connectors/external-conversation-link'
import type { ThreadStatusDeps } from './thread-status'

// A running turn holds the lines this long, unless it waits on a prompt in the thread.
const RUNNING_TURN_HOLD_MS = 30 * 60_000

export async function threadStatusHeld(
  deps: Pick<ThreadStatusDeps, 'runningTurn' | 'cloud' | 'answerPending'>,
  link: ExternalConversationLink,
  /** The pane's latest heard turn end, when known. */
  turnId: number | null,
  promptOpen: boolean,
  now: number
): Promise<boolean> {
  const running = deps.runningTurn(link.paneKey)
  if (running !== null && (now - running < RUNNING_TURN_HOLD_MS || promptOpen)) {
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
  const mirrorHeld = (link.mirrorHeld ?? []).some(
    ({ event }) =>
      typeof event === 'object' && event !== null && 'turnId' in event && event.turnId === turnId
  )
  if (mirrorHeld || !deps.answerPending) {
    return mirrorHeld
  }
  // A read that fails holds the line rather than let it go before the answer.
  return await deps.answerPending(link, turnId).then(
    (unsent) => unsent,
    () => true
  )
}
