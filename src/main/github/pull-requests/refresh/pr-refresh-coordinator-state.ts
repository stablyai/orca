import { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import { PRRefreshPacing } from './pr-refresh-pacing'
import { PRRefreshQueue } from './pr-refresh-queue'
import { PRRefreshQueueDrainer } from './pr-refresh-queue-drainer'
import { PRRefreshRetryState } from './pr-refresh-retry-state'
import { PRRefreshVisibility } from './pr-refresh-visibility'
import { setPRBranchReadCompletion } from '../../client/lookup/pr-branch-read-resources'

export const retry = new PRRefreshRetryState()
// Dropping an old gate index entry must not forget a visible row's current failure.
export const queue = new PRRefreshQueue((key) => {
  if (!visibility.has(key)) {
    retry.reset(key)
  }
})
export const pacing = new PRRefreshPacing()
// A row no longer shown owes no retry for its failure (only its rate-limit gate stays), and its
// queued visible read is dropped.
export const visibility = new PRRefreshVisibility((key) => {
  retry.releaseFailure(key)
  const entry = queue.get(key)
  if (entry?.reason === 'visible') {
    queue.delete(key)
    events.broadcast({
      aliases: Array.from(entry.aliases.values()),
      reason: 'visible',
      status: 'skipped',
      skippedReason: 'fresh'
    })
  }
})
export const events = new PRRefreshEventPublisher()
export const drainer = new PRRefreshQueueDrainer(queue, pacing, visibility, retry, events)
setPRBranchReadCompletion((outcome, producer, prepared, request) =>
  drainer.scheduler.reconcileCompletion(outcome, prepared, request, producer)
)
