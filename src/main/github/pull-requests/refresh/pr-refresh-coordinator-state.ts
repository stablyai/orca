import { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import { PRRefreshPacing } from './pr-refresh-pacing'
import { PRRefreshQueue } from './pr-refresh-queue'
import { PRRefreshQueueDrainer } from './pr-refresh-queue-drainer'
import { PRRefreshRetryState } from './pr-refresh-retry-state'
import { PRRefreshVisibility } from './pr-refresh-visibility'

// One coordinator per host process: ordinary refreshes and detail-recovery tickets share it.
export const retry = new PRRefreshRetryState()
export const queue = new PRRefreshQueue((key) => retry.reset(key))
export const pacing = new PRRefreshPacing()
export const visibility = new PRRefreshVisibility()
export const events = new PRRefreshEventPublisher()
export const drainer = new PRRefreshQueueDrainer(queue, pacing, visibility, retry, events)
