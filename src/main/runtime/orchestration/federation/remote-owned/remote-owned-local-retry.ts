import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import { OrchestrationError } from '../../orchestration-error'
import {
  unlinkedOnPairedComputer,
  withQuestionLink
} from '../../../rpc/methods/orchestration/worker/start/worker-question-link'

/** The attempt here a retry --on names; the server never saw it, so the retry starts afresh there. */
export function attemptHereRetriedOnServer(
  db: OrchestrationDb,
  retryOf: string | undefined
): DispatchContextRow | undefined {
  const prior = retryOf ? db.getDispatchContextById(retryOf) : undefined
  if (prior?.origin_ref) {
    throw new OrchestrationError(
      'invalid_argument',
      `Dispatch ${prior.id} works on a bot item, so its retry can't use --on: an item's workers start on this computer, where the item is. No effects were applied.`,
      { effectsApplied: false }
    )
  }
  return prior
}

/** The question the attempt here was for stays here: a worker on a server can't be linked to it. */
export function withQuestionLeftHere<T>(
  prior: DispatchContextRow | undefined,
  forQuestion: string | undefined,
  placed: T
): T {
  const question = forQuestion === undefined ? prior?.for_message_id : null
  return withQuestionLink(question ? unlinkedOnPairedComputer(question) : undefined, placed)
}
