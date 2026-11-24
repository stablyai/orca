import { AppState } from 'react-native'
import { isLiveActivityRetiring } from './live-activity-retirement'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { translate } from '../i18n/mobile-i18n'
import { nativeLiveActivities, type NativeActivity } from './native-live-activities'
import { loadLiveActivityPreferences } from './live-activity-preferences'
import type { LiveActivityTrackParams } from './live-activity-track-contract'
import {
  createLiveActivityCohort,
  discoverLiveActivitySources,
  forgetLiveActivityCohort,
  loadLiveActivityCohort
} from './live-activity-overview-enrollment'

export async function startLiveActivityOverview(
  hostId: string,
  input: LiveActivityTrackParams,
  hosts: ReadonlyMap<string, RpcClient>,
  current: () => boolean
): Promise<NativeActivity | null> {
  const canStart = (): boolean => current() && AppState.currentState === 'active'
  if (!nativeLiveActivities || !canStart()) {
    return null
  }
  const preferences = await loadLiveActivityPreferences()
  if (!preferences.enabled || !(await nativeLiveActivities.authorization())) {
    return null
  }
  const activities = await nativeLiveActivities.activities()
  const saved = await loadLiveActivityCohort()
  const existing = activities.find(
    (activity) =>
      ['active', 'stale'].includes(activity.state) && activity.linkId === saved?.overviewId
  )
  if (!canStart()) {
    return null
  }
  if (existing) {
    return !(await isLiveActivityRetiring(existing.activityId)) && canStart() ? existing : null
  }
  if (activities.some((activity) => ['active', 'stale'].includes(activity.state))) {
    return null
  }
  const seed = { hostId, ...input }
  if (await nativeLiveActivities.hasTurn(seed)) {
    return null
  }
  if (!canStart()) {
    return null
  }
  await forgetLiveActivityCohort()
  const sources = await discoverLiveActivitySources(hosts, canStart)
  const cohort = await createLiveActivityCohort(sources, hostId, canStart)
  if (!cohort || !canStart()) {
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
