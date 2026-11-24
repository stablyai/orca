import { AppState } from 'react-native'
import { runKeyedSerializedOperation } from '../../../src/shared/concurrency/keyed-serialized-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { translate } from '../i18n/mobile-i18n'
import { nativeLiveActivities, type NativeActivity } from './native-live-activities'
import {
  loadLiveActivityPreferences,
  saveLiveActivityPreferences,
  notifyLiveActivityPreferences,
  type LiveActivityPreferences
} from './live-activity-preferences'
import {
  liveActivityTrackParamsSchema,
  type LiveActivityTrackParams
} from './live-activity-track-contract'
import {
  createLiveActivityCohort,
  discoverLiveActivitySources,
  forgetLiveActivityCohort,
  liveActivitySourcesMatch,
  loadLiveActivityCohort,
  type LiveActivityCohort
} from './live-activity-overview-enrollment'
import {
  registerLiveActivityOverview,
  unregisterLiveActivityOverview
} from './live-activity-overview-registration'
import { setLiveActivityDeliveryFailed } from './live-activity-delivery-status'

const hosts = new Map<string, RpcClient>()
const registrations = new Map<string, Promise<void>>()
let generation = 0
let changingPreferences = false
let chain = Promise.resolve()
let lastSeed: { hostId: string; input: LiveActivityTrackParams } | null = null

function queue<T>(run: () => Promise<T>): Promise<T> {
  const result = chain.then(run)
  chain = result.then(
    () => {},
    () => {
      setLiveActivityDeliveryFailed(true)
    }
  )
  return result
}

async function stopOverview(
  activity: NativeActivity,
  cohort: LiveActivityCohort | null
): Promise<void> {
  await nativeLiveActivities?.end(activity.activityId)
  if (cohort?.overviewId === activity.linkId) {
    await unregisterLiveActivityOverview(activity.activityId, cohort, hosts)
  }
  await nativeLiveActivities?.forgetRoute(activity.linkId)
}

function register(activity: NativeActivity): Promise<void> {
  return runKeyedSerializedOperation(registrations, activity.activityId, async () => {
    if (!nativeLiveActivities) {
      return
    }
    const currentActivity = (await nativeLiveActivities.activities()).find(
      (item) => item.activityId === activity.activityId
    )
    if (
      !currentActivity ||
      !['active', 'stale'].includes(currentActivity.state) ||
      !currentActivity.token
    ) {
      return
    }
    const revision = generation
    const cohort = await loadLiveActivityCohort()
    const preferences = await loadLiveActivityPreferences()
    if (
      cohort?.overviewId !== activity.linkId ||
      !preferences.enabled ||
      !(await nativeLiveActivities.authorization())
    ) {
      return
    }
    const current = (): boolean => revision === generation && !changingPreferences
    const accepted = await registerLiveActivityOverview(
      currentActivity,
      cohort,
      hosts,
      preferences.showNames,
      current
    )
    if (current()) {
      setLiveActivityDeliveryFailed(!accepted)
    }
    if (!current()) {
      await unregisterLiveActivityOverview(activity.activityId, cohort, hosts)
    }
  })
}

async function reconcile(): Promise<void> {
  if (!nativeLiveActivities || changingPreferences) {
    return
  }
  const preferences = await loadLiveActivityPreferences()
  const allowed = preferences.enabled && (await nativeLiveActivities.authorization())
  const cohort = await loadLiveActivityCohort()
  const activities = await nativeLiveActivities.activities()
  for (const activity of activities) {
    if (cohort?.overviewId === activity.linkId && !['active', 'stale'].includes(activity.state)) {
      await unregisterLiveActivityOverview(activity.activityId, cohort, hosts)
      continue
    }
    if (
      !allowed ||
      activity.linkId !== cohort?.overviewId ||
      !['active', 'stale'].includes(activity.state)
    ) {
      await stopOverview(activity, cohort)
      continue
    }
    const route = await nativeLiveActivities.route(activity.linkId)
    if (route?.worktreeId && route.paneKey && route.turnKey) {
      lastSeed = {
        hostId: route.hostId,
        input: {
          worktreeId: route.worktreeId,
          paneKey: route.paneKey,
          turnKey: route.turnKey,
          ...(route.executionHost ? { executionHost: route.executionHost } : {})
        }
      }
    }
    if (AppState.currentState === 'active') {
      const sources = await discoverLiveActivitySources(hosts)
      if (!liveActivitySourcesMatch(cohort, sources)) {
        generation++
        await stopOverview(activity, cohort)
        await forgetLiveActivityCohort()
        if (lastSeed) {
          await track(lastSeed.hostId, lastSeed.input)
        }
        return
      }
    }
    await register(activity)
  }
}

export function attachLiveActivityHost(hostId: string, client: RpcClient): () => void {
  hosts.set(hostId, client)
  notifyLiveActivityPreferences()
  void queue(reconcile).catch(() => undefined)
  return () => {
    if (hosts.get(hostId) === client) {
      hosts.delete(hostId)
    }
  }
}

export function startLiveActivitySync(): () => void {
  if (!nativeLiveActivities) {
    return () => {}
  }
  const token = nativeLiveActivities.addListener('onToken', (activity) => {
    void register(activity).catch(() => setLiveActivityDeliveryFailed(true))
  })
  const activityState = nativeLiveActivities.addListener('onState', (activity) => {
    if (activity.state === 'ended' || activity.state === 'dismissed') {
      void loadLiveActivityCohort()
        .then((cohort) => {
          if (cohort?.overviewId === activity.linkId) {
            return unregisterLiveActivityOverview(activity.activityId, cohort, hosts)
          }
        })
        .catch(() => undefined)
    }
  })
  const state = AppState.addEventListener('change', (value) => {
    if (value === 'active') {
      void queue(reconcile).catch(() => undefined)
    }
  })
  void queue(reconcile).catch(() => undefined)
  return () => {
    token.remove()
    activityState.remove()
    state.remove()
  }
}

export async function setLiveActivityPreferences(value: LiveActivityPreferences): Promise<void> {
  generation++
  changingPreferences = true
  try {
    await saveLiveActivityPreferences(value)
    const cohort = await loadLiveActivityCohort()
    if (nativeLiveActivities) {
      for (const activity of await nativeLiveActivities.activities()) {
        await stopOverview(activity, cohort)
      }
    }
    await forgetLiveActivityCohort()
  } finally {
    changingPreferences = false
    notifyLiveActivityPreferences()
  }
  if (value.enabled && lastSeed) {
    const seed = lastSeed
    await queue(() => track(seed.hostId, seed.input))
  }
}

export async function forgetHostLiveActivities(_hostId: string): Promise<void> {
  generation++
  const cohort = await loadLiveActivityCohort()
  if (nativeLiveActivities) {
    for (const activity of await nativeLiveActivities.activities()) {
      await stopOverview(activity, cohort)
    }
  }
  await forgetLiveActivityCohort()
  notifyLiveActivityPreferences()
}

export function trackLiveActivity(hostId: string, raw: unknown): Promise<{ tracked: boolean }> {
  const input = liveActivityTrackParamsSchema.parse(raw)
  lastSeed = { hostId, input }
  return queue(() => track(hostId, input))
}

async function track(
  hostId: string,
  input: LiveActivityTrackParams
): Promise<{ tracked: boolean }> {
  const revision = generation
  if (!nativeLiveActivities || changingPreferences || AppState.currentState !== 'active') {
    return { tracked: false }
  }
  const preferences = await loadLiveActivityPreferences()
  if (!preferences.enabled || !(await nativeLiveActivities.authorization())) {
    return { tracked: false }
  }
  const existing = (await nativeLiveActivities.activities()).find((activity) =>
    ['active', 'stale'].includes(activity.state)
  )
  if (existing) {
    await register(existing)
    return { tracked: true }
  }
  const seed = { hostId, ...input }
  if (await nativeLiveActivities.hasTurn(seed)) {
    return { tracked: false }
  }
  await forgetLiveActivityCohort()
  const sources = await discoverLiveActivitySources(hosts)
  const cohort = await createLiveActivityCohort(
    sources,
    hostId,
    () => revision === generation && !changingPreferences
  )
  if (!cohort) {
    return { tracked: false }
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
  if (revision !== generation) {
    return { tracked: false }
  }
  const activityId = await nativeLiveActivities.start(
    cohort.overviewId,
    { ...seed, overviewId: cohort.overviewId, scopeCount: String(cohort.scopes.length) },
    'Orca',
    labels
  )
  const activity = (await nativeLiveActivities.activities()).find(
    (item) => item.activityId === activityId
  )
  if (revision !== generation) {
    if (activity) {
      await stopOverview(activity, cohort)
    }
    return { tracked: false }
  }
  if (activity) {
    await register(activity)
  }
  return { tracked: true }
}
