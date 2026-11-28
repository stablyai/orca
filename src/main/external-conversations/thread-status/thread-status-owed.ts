// What to do with a thread's saved line just before it would post, from all that is known without
// waiting. Pure, so each way a line stops being owed is pinned by a test.
import type { ThreadStatusFact } from '../../../shared/connectors/external-conversation-link'
import {
  decideThreadStatus,
  threadStatusUpdate,
  type ThreadStatusView
} from './thread-status-decide'
import { stalePending } from './thread-status-fact'

// A line decided longer ago than this is dropped, never posted with a stale elapsed time.
export const THREAD_STATUS_PENDING_MAX_MS = 10 * 60_000

export type SavedLineInput = {
  now: number
  fact: ThreadStatusFact | undefined
  view: ThreadStatusView | undefined
  eligible: boolean
  /** A turn, a prompt, an unsent or queued answer, or a turn just ended holds it. */
  held: boolean
  /** The latest answer read found nothing unsent for this pane's current turn, and no turn has
   *  ended since that read began. */
  answerClear: boolean
  /** A client runs and has said hello. */
  cloudReady: boolean
  /** The saved line may already be in the thread: any but one this process knows it never sent. */
  mayHavePosted: boolean
}

/** `send` the saved line as it is; `drop` it (stale, overtaken or no longer what the workers'
 *  state says) so the next tick decides afresh; `disarm` the run; or `wait` and keep it. */
export type SavedLineNow = 'send' | 'drop' | 'disarm' | 'wait'

export function savedLineNow(input: SavedLineInput): SavedLineNow {
  const { now, fact, view, eligible, held, mayHavePosted } = input
  const pending = fact?.pending
  if (!fact?.armed || !pending) {
    return 'wait'
  }
  if (stalePending(fact, now, THREAD_STATUS_PENDING_MAX_MS)) {
    return 'drop'
  }
  const decided = decideThreadStatus({
    now,
    fact,
    view,
    eligible,
    held,
    pendingMayHavePosted: mayHavePosted
  })
  if (decided.kind !== 'post') {
    return decided.kind
  }
  // The same line a fresh decision would post: a stop line, or the update for the workers' state
  // now at the time it was saved; one that no longer says what is true is never posted.
  const same = decided.stop
    ? pending.stop
    : !pending.stop &&
      !!view &&
      threadStatusUpdate(view, pending.at - fact.armed.at) === pending.text
  if (!same) {
    return 'drop'
  }
  return input.answerClear && input.cloudReady ? 'send' : 'wait'
}
