import { deliverLiveActivityOverview } from './live-activity-overview-delivery'
import { AppState } from 'react-native'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
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
  cleanupLiveActivitySecrets,
  discoverLiveActivitySources,
  forgetLiveActivityCohort,
  liveActivitySourcesMatch,
  loadLiveActivityCohort
} from './live-activity-overview-enrollment'
import { unregisterLiveActivityOverview } from './live-activity-overview-registration'
import {
  endLiveActivityOverview,
  retireCurrentLiveActivityOverview,
  isLiveActivityRetiring,
  retryLiveActivityRetirements
} from './live-activity-retirement'
import { startLiveActivityOverview } from './live-activity-overview-start'
import {
  setLiveActivityDeliveryFailed,
  setLiveActivityCleanupPending
} from './live-activity-delivery-status'

const hosts = new Map<string, RpcClient>()
let generation = 0
let pendingChanges = 0
let users = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let chain = Promise.resolve()
let lastSeed: { hostId: string; input: LiveActivityTrackParams } | null = null

function queue<T>(run: () => Promise<T>): Promise<T> {
  const result = chain.then(run)
  chain = result.then(
    () => {},
    () => {}
  )
  return result
}

function scheduleRetry(): void {
  if (retryTimer || !users || AppState.currentState !== 'active') {
    return
  }
  retryTimer = setTimeout(() => {
    retryTimer = null
    enqueueReconcile()
  }, 30_000)
}

function enqueueReconcile(): void {
  void queue(reconcile).catch(() => {
    setLiveActivityCleanupPending(true)
    scheduleRetry()
  })
}

function register(activity: NativeActivity): Promise<boolean> {
  if (pendingChanges) {
    return Promise.resolve(true)
  }
  const revision = generation
  return deliverLiveActivityOverview(activity, hosts, () => revision === generation).catch(() => {
    if (revision !== generation) {
      return true
    }
    setLiveActivityDeliveryFailed(true)
    return false
  })
}

async function reconcile(): Promise<void> {
  if (!nativeLiveActivities || pendingChanges) {
    return
  }
  let cleanupPending = false
  try {
    cleanupPending = !(await retryLiveActivityRetirements(hosts))
    await cleanupLiveActivitySecrets()
  } catch {
    cleanupPending = true
  }
  const preferences = await loadLiveActivityPreferences()
  const allowed = preferences.enabled && (await nativeLiveActivities.authorization())
  const cohort = await loadLiveActivityCohort()
  const activities = await nativeLiveActivities.activities()
  let retry = false
  let retained = false
  let active = false
  for (const activity of activities) {
    if (cohort?.overviewId === activity.linkId && !['active', 'stale'].includes(activity.state)) {
      cleanupPending =
        !(await unregisterLiveActivityOverview(activity.activityId, cohort, hosts)) ||
        cleanupPending
      continue
    }
    if (
      !allowed ||
      activity.linkId !== cohort?.overviewId ||
      !['active', 'stale'].includes(activity.state)
    ) {
      try {
        cleanupPending = !(await endLiveActivityOverview(activity, cohort, hosts)) || cleanupPending
      } catch {
        retained = true
        cleanupPending = true
      }
      continue
    }
    if (await isLiveActivityRetiring(activity.activityId)) {
      cleanupPending = true
      continue
    }
    active = true
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
      const sources = await discoverLiveActivitySources(
        hosts,
        () => AppState.currentState === 'active'
      )
      if (AppState.currentState !== 'active') {
        return
      }
      if (!liveActivitySourcesMatch(cohort, sources)) {
        generation++
        cleanupPending = !(await endLiveActivityOverview(activity, cohort, hosts)) || cleanupPending
        await forgetLiveActivityCohort(cohort.overviewId)
        active = false
        continue
      }
    }
    retry = !(await register(activity)) || retry
  }
  if (!allowed && !retained) {
    await forgetLiveActivityCohort(cohort?.overviewId)
  }
  if (allowed && !active && lastSeed) {
    await track(lastSeed.hostId, lastSeed.input)
  }
  if (!preferences.enabled) {
    setLiveActivityDeliveryFailed(false)
  }
  setLiveActivityCleanupPending(cleanupPending)
  if (retry || cleanupPending) {
    scheduleRetry()
  }
}

export function attachLiveActivityHost(hostId: string, client: RpcClient): () => void {
  hosts.set(hostId, client)
  const unsubscribe = client.onStateChange((state) => {
    if (state === 'connected') {
      enqueueReconcile()
    }
  })
  notifyLiveActivityPreferences()
  enqueueReconcile()
  return () => {
    unsubscribe()
    if (hosts.get(hostId) === client) {
      hosts.delete(hostId)
    }
  }
}

export function startLiveActivitySync(): () => void {
  if (!nativeLiveActivities) {
    return () => {}
  }
  users++
  const token = nativeLiveActivities.addListener('onToken', (activity) => {
    void register(activity)
      .then((accepted) => {
        if (!accepted) {
          scheduleRetry()
        }
      })
      .catch(() => {
        setLiveActivityDeliveryFailed(true)
        scheduleRetry()
      })
  })
  const activityState = nativeLiveActivities.addListener('onState', (activity) => {
    if (activity.state === 'ended' || activity.state === 'dismissed') {
      void loadLiveActivityCohort()
        .then(async (cohort) => {
          if (cohort?.overviewId === activity.linkId) {
            generation++
            setLiveActivityDeliveryFailed(false)
            await unregisterLiveActivityOverview(activity.activityId, cohort, hosts)
          }
        })
        .finally(enqueueReconcile)
        .catch(() => setLiveActivityCleanupPending(true))
    }
  })
  const state = AppState.addEventListener('change', (value) => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (value === 'active') {
      enqueueReconcile()
    }
  })
  enqueueReconcile()
  return () => {
    users--
    token.remove()
    activityState.remove()
    state.remove()
    if (!users && retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }
}

function changeLifecycle(run: () => Promise<void>, invalidateOnStart = true): Promise<void> {
  if (invalidateOnStart) {
    generation++
  }
  pendingChanges++
  return queue(async () => {
    try {
      await run()
    } finally {
      pendingChanges--
      notifyLiveActivityPreferences()
      enqueueReconcile()
    }
  })
}

export function setLiveActivityPreferences(value: LiveActivityPreferences): Promise<void> {
  return changeLifecycle(async () => {
    await saveLiveActivityPreferences(value)
    // Keep an in-flight enrollment valid until the preference write commits.
    generation++
    setLiveActivityDeliveryFailed(false)
    try {
      await retireCurrentLiveActivityOverview(hosts)
    } catch {
      setLiveActivityCleanupPending(true)
    }
  }, false)
}

export function forgetHostLiveActivities(_hostId: string): Promise<void> {
  return changeLifecycle(() => retireCurrentLiveActivityOverview(hosts))
}

export function retryLiveActivityCleanup(): Promise<void> {
  return queue(reconcile)
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
  if (pendingChanges) {
    return { tracked: false }
  }
  const revision = generation
  const current = (): boolean => revision === generation
  const activity = await startLiveActivityOverview(hostId, input, hosts, current)
  if (!activity) {
    return { tracked: false }
  }
  if (!current()) {
    await endLiveActivityOverview(activity, await loadLiveActivityCohort(), hosts)
    return { tracked: false }
  }
  if (!(await register(activity))) {
    scheduleRetry()
  }
  return { tracked: true }
}
