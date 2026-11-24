import { AppState } from 'react-native'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { translate } from '../i18n/mobile-i18n'
import { nativeLiveActivities, type NativeActivity } from './native-live-activities'
import { loadLiveActivityPreferences } from './live-activity-preferences'
import type { LiveActivityTrackParams } from './live-activity-track-contract'
import {
  createLiveActivityCohort,
  discoverLiveActivitySources,
  forgetLiveActivityCohort
} from './live-activity-overview-enrollment'

export async function startLiveActivityOverview(
  hostId: string,
  input: LiveActivityTrackParams,
  hosts: ReadonlyMap<string, RpcClient>,
  current: () => boolean
): Promise<NativeActivity | null> {
  if (!nativeLiveActivities || !current() || AppState.currentState !== 'active') {
    return null
  }
  const preferences = await loadLiveActivityPreferences()
  if (!preferences.enabled || !(await nativeLiveActivities.authorization())) {
    return null
  }
  const existing = (await nativeLiveActivities.activities()).find((activity) =>
    ['active', 'stale'].includes(activity.state)
  )
  if (existing) {
    return existing
  }
  const seed = { hostId, ...input }
  if (await nativeLiveActivities.hasTurn(seed)) {
    return null
  }
  if (!current()) {
    return null
  }
  await forgetLiveActivityCohort()
  const sources = await discoverLiveActivitySources(hosts)
  const cohort = await createLiveActivityCohort(sources, hostId, current)
  if (!cohort || !current()) {
    return null
  }
  const labels = {
    working: translate('liveActivities.working', 'Working'),
    attention: translate('liveActivities.attention', 'Needs attention'),
    done: translate('liveActivities.done', 'Completed'),
    failed: translate('liveActivities.failed', 'Failed'),
    unavailable: translate('liveActivities.unavailable', 'Status unavailable'),
    session: translate('liveActivities.session', 'Session'),
    allHosts: translate('liveActivities.allHosts', 'All paired hosts'),
    partial: translate('liveActivities.partial', 'Partial coverage'),
    more: translate('liveActivities.more', 'more')
  }
  const activityId = await nativeLiveActivities.start(
    cohort.overviewId,
    { ...seed, overviewId: cohort.overviewId, scopeCount: String(cohort.scopes.length) },
    'Orca',
    labels
  )
  return (
    (await nativeLiveActivities.activities()).find((item) => item.activityId === activityId) ?? null
  )
}
