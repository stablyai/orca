import type { RelayControlOrigin } from './relay-control-origin'
import type { RelayDrainMessage, RelayRegionRestoredMessage } from './relay-control-protocol'
import { RelayHttpError, requestRelayAssignment, type RelayAssignment } from './relay-http-client'
import type { RelayDrainRetrySchedule } from './relay-drain-retry-schedule'

type RestorationOptions = {
  directorUrl: string
  relayHostId: string
  token: () => string | null
  isCurrent: () => boolean
  assignment: () => RelayAssignment | null
  retained: Map<RelayControlOrigin, NonNullable<RelayDrainMessage['retention']>>
  invalidateAuthority: () => number
  authority: () => number
  restore: (origin: RelayControlOrigin, assignment: RelayAssignment) => void
  retry: RelayDrainRetrySchedule
  fetch?: typeof globalThis.fetch
}

export async function restoreRelayOrigin(
  options: RestorationOptions,
  origin: RelayControlOrigin,
  message: RelayRegionRestoredMessage
): Promise<void> {
  const retained = options.retained.get(origin)
  const token = options.token()
  if (
    !options.isCurrent() ||
    !retained ||
    !token ||
    retained.attemptId !== message.attemptId ||
    retained.sourceGeneration !== message.sourceGeneration ||
    retained.sourceAssignmentEpoch !== message.sourceAssignmentEpoch ||
    message.assignmentEpoch <=
      Math.max(retained.sourceAssignmentEpoch, options.assignment()?.assignmentEpoch ?? 0) ||
    !origin.hasLiveControl()
  ) {
    return
  }
  const authority = options.invalidateAuthority()
  try {
    const assignment = await requestRelayAssignment({
      directorUrl: options.directorUrl,
      relayToken: token,
      relayHostId: options.relayHostId,
      reconnect: true,
      isCurrent: options.isCurrent,
      fetch: options.fetch
    })
    if (
      !options.isCurrent() ||
      authority !== options.authority() ||
      options.retained.get(origin) !== retained ||
      !origin.hasLiveControl() ||
      assignment.cellUrl !== origin.cellUrl ||
      assignment.assignmentEpoch !== message.assignmentEpoch
    ) {
      return
    }
    options.retry.cancel()
    options.restore(origin, assignment)
  } catch (error) {
    if (
      options.isCurrent() &&
      authority === options.authority() &&
      options.retained.get(origin) === retained &&
      origin.hasLiveControl()
    ) {
      const delay = error instanceof RelayHttpError ? (error.retryAfterMs ?? 0) : 0
      options.retry.schedule(delay, () => void restoreRelayOrigin(options, origin, message))
    }
  }
}
