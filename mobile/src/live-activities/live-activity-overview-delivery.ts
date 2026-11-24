import { runKeyedSerializedOperation } from '../../../src/shared/concurrency/keyed-serialized-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { nativeLiveActivities, type NativeActivity } from './native-live-activities'
import { loadLiveActivityCohort } from './live-activity-overview-enrollment'
import { loadLiveActivityPreferences } from './live-activity-preferences'
import { isLiveActivityRetiring } from './live-activity-retirement'
import {
  registerLiveActivityOverview,
  unregisterLiveActivityOverview
} from './live-activity-overview-registration'
import { setLiveActivityDeliveryFailed } from './live-activity-delivery-status'

const registrations = new Map<string, Promise<void>>()

export function deliverLiveActivityOverview(
  activity: NativeActivity,
  hosts: ReadonlyMap<string, RpcClient>,
  current: () => boolean
): Promise<boolean> {
  return runKeyedSerializedOperation(registrations, activity.activityId, async () => {
    if (
      !nativeLiveActivities ||
      !current() ||
      (await isLiveActivityRetiring(activity.activityId))
    ) {
      return true
    }
    const currentActivity = (await nativeLiveActivities.activities()).find(
      (item) => item.activityId === activity.activityId
    )
    if (!currentActivity || !['active', 'stale'].includes(currentActivity.state)) {
      return true
    }
    if (!currentActivity.token) {
      return false
    }
    const cohort = await loadLiveActivityCohort()
    const preferences = await loadLiveActivityPreferences()
    if (
      cohort?.overviewId !== activity.linkId ||
      !preferences.enabled ||
      !(await nativeLiveActivities.authorization())
    ) {
      return true
    }
    const accepted = await registerLiveActivityOverview(
      currentActivity,
      cohort,
      hosts,
      preferences.showNames,
      current
    )
    if (current()) {
      setLiveActivityDeliveryFailed(!accepted)
    } else {
      await unregisterLiveActivityOverview(activity.activityId, cohort, hosts)
    }
    return accepted
  })
}
