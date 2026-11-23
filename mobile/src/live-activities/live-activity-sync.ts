import { setLiveActivityDeliveryFailed } from './live-activity-delivery-status'
import { runKeyedSerializedOperation } from '../../../src/shared/concurrency/keyed-serialized-operations'
import { AppState } from 'react-native'
import * as Crypto from 'expo-crypto'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { translate } from '../i18n/mobile-i18n'
import {
  nativeLiveActivities,
  type LiveActivityRoute,
  type NativeActivity
} from './native-live-activities'
import {
  loadLiveActivityPreferences,
  saveLiveActivityPreferences,
  type LiveActivityPreferences
} from './live-activity-preferences'
import { registerLiveActivity, unregisterLiveActivity } from './live-activity-operations'
import {
  liveActivityTrackParamsSchema,
  type LiveActivityTrackParams
} from './live-activity-track-contract'

const hosts = new Map<string, RpcClient>()
const attempts = new Set<string>()
const registrations = new Map<string, Promise<void>>()
let generation = 0
let chain = Promise.resolve()

function register(activity: NativeActivity): Promise<void> {
  return runKeyedSerializedOperation(registrations, activity.activityId, () =>
    registerCurrent(activity)
  )
}

async function registerCurrent(previous: NativeActivity): Promise<void> {
  if (!nativeLiveActivities) {
    return
  }
  const activity = (await nativeLiveActivities.activities()).find(
    (item) => item.activityId === previous.activityId
  )
  if (!activity || !['active', 'stale'].includes(activity.state)) {
    return
  }
  if (!nativeLiveActivities || !activity.token) {
    return
  }
  const revision = generation
  const route = await nativeLiveActivities.route(activity.linkId)
  const preferences = await loadLiveActivityPreferences()
  if (!route) {
    return
  }
  if (!preferences.enabled || !(await nativeLiveActivities.authorization())) {
    await end(activity, route)
    return
  }
  const client = hosts.get(route.hostId)
  if (!client) {
    return
  }
  const reply = await registerLiveActivity
    .request(
      client,
      {
        activityId: activity.activityId,
        token: activity.token,
        apnsEnvironment: await nativeLiveActivities.environment(),
        worktreeId: route.worktreeId,
        paneKey: route.paneKey,
        showNames: preferences.showNames
      },
      {
        timeoutMs: 10_000,
        failWhenDisconnected: true,
        ...(route.executionHost ? { envelope: { executionHost: route.executionHost } } : {})
      }
    )
    .catch(() => null)
  const result = reply ? registerLiveActivity.interpret(reply) : null
  if (revision === generation) {
    setLiveActivityDeliveryFailed(!result?.accepted || !result.value?.registered)
  }
  if (revision !== generation || !result?.accepted || !result.value?.registered) {
    await end(activity, route)
    attempts.delete(routeIdentity(route))
    await nativeLiveActivities.forgetRoute(activity.linkId)
  }
}

function routeIdentity(route: LiveActivityRoute): string {
  return JSON.stringify([
    route.hostId,
    route.executionHost,
    route.worktreeId,
    route.paneKey,
    route.turnKey
  ])
}

async function end(
  activity: NativeActivity,
  route: LiveActivityRoute,
  dismiss = true
): Promise<void> {
  if (dismiss) {
    await nativeLiveActivities?.end(activity.activityId)
  }
  const client = hosts.get(route.hostId)
  if (client) {
    await unregisterLiveActivity
      .request(
        client,
        { activityId: activity.activityId },
        {
          timeoutMs: 5_000,
          failWhenDisconnected: true,
          ...(route.executionHost ? { envelope: { executionHost: route.executionHost } } : {})
        }
      )
      .catch(() => null)
  }
}

async function reconcile(): Promise<void> {
  if (!nativeLiveActivities) {
    return
  }
  const preferences = await loadLiveActivityPreferences()
  const authorized = await nativeLiveActivities.authorization()
  for (const activity of await nativeLiveActivities.activities()) {
    const route = await nativeLiveActivities.route(activity.linkId)
    if (!route) {
      continue
    }
    if (!preferences.enabled || !authorized || !['active', 'stale'].includes(activity.state)) {
      await end(activity, route, !preferences.enabled || !authorized)
    } else {
      await register(activity).catch(() => undefined)
    }
  }
}

export function attachLiveActivityHost(hostId: string, client: RpcClient): () => void {
  hosts.set(hostId, client)
  void reconcile().catch(() => undefined)
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
    void register(activity).catch(() => undefined)
  })
  const activityState = nativeLiveActivities.addListener('onState', (activity) => {
    if (activity.state === 'ended' || activity.state === 'dismissed') {
      void nativeLiveActivities
        ?.route(activity.linkId)
        .then((route) => route && end(activity, route, false))
        .catch(() => undefined)
    }
  })
  const state = AppState.addEventListener('change', (value) => {
    if (value === 'active') {
      void reconcile().catch(() => undefined)
    }
  })
  void reconcile().catch(() => undefined)
  return () => {
    token.remove()
    activityState.remove()
    state.remove()
  }
}

export async function setLiveActivityPreferences(value: LiveActivityPreferences): Promise<void> {
  generation++
  await saveLiveActivityPreferences(value)
  // End immediately on any privacy change: old visible content must not survive a revoked choice.
  if (nativeLiveActivities) {
    for (const activity of await nativeLiveActivities.activities()) {
      const route = await nativeLiveActivities.route(activity.linkId)
      if (route) {
        await end(activity, route)
      }
    }
  }
}

export async function forgetHostLiveActivities(hostId: string): Promise<void> {
  if (!nativeLiveActivities) {
    return
  }
  for (const activity of await nativeLiveActivities.activities()) {
    const route = await nativeLiveActivities.route(activity.linkId)
    if (route?.hostId === hostId) {
      await end(activity, route)
    }
  }
}

export function trackLiveActivity(hostId: string, raw: unknown): Promise<{ tracked: boolean }> {
  const input = liveActivityTrackParamsSchema.parse(raw)
  const run = chain.then(() => track(hostId, input))
  chain = run.then(
    () => {},
    () => {
      setLiveActivityDeliveryFailed(true)
    }
  )
  return run
}

async function track(
  hostId: string,
  input: LiveActivityTrackParams
): Promise<{ tracked: boolean }> {
  const revision = generation
  if (!nativeLiveActivities || AppState.currentState !== 'active') {
    return { tracked: false }
  }
  const preferences = await loadLiveActivityPreferences()
  if (!preferences.enabled || !(await nativeLiveActivities.authorization())) {
    return { tracked: false }
  }
  const route: LiveActivityRoute = { hostId, ...input }
  const identity = routeIdentity(route)
  if (attempts.has(identity)) {
    return { tracked: true }
  }
  const activities = await nativeLiveActivities.activities()
  for (const activity of activities) {
    const previous = await nativeLiveActivities.route(activity.linkId)
    if (
      previous?.hostId === route.hostId &&
      previous.executionHost === route.executionHost &&
      previous.worktreeId === route.worktreeId &&
      previous.paneKey === route.paneKey &&
      ['active', 'stale'].includes(activity.state)
    ) {
      return { tracked: true }
    }
  }
  if (await nativeLiveActivities.hasTurn(route)) {
    return { tracked: false }
  }
  if (
    activities.filter((activity) => activity.state === 'active' || activity.state === 'stale')
      .length >= 4
  ) {
    return { tracked: false }
  }
  const linkId = Crypto.randomUUID()
  const labels = {
    working: translate('liveActivities.working', 'Working'),
    attention: translate('liveActivities.attention', 'Needs attention'),
    done: translate('liveActivities.done', 'Completed'),
    failed: translate('liveActivities.failed', 'Failed'),
    unavailable: translate('liveActivities.unavailable', 'Status unavailable')
  }
  if (revision !== generation) {
    return { tracked: false }
  }
  const activityId = await nativeLiveActivities.start(linkId, route, 'Orca', labels)
  if (revision !== generation) {
    await end({ activityId, linkId, token: '', state: 'active' }, route)
    await nativeLiveActivities.forgetRoute(linkId)
    return { tracked: false }
  }
  attempts.add(identity)
  if (attempts.size > 256) {
    attempts.delete(attempts.values().next().value!)
  }
  const activity = (await nativeLiveActivities.activities()).find(
    (item) => item.activityId === activityId
  )
  if (activity) {
    await register(activity)
  }
  return { tracked: true }
}
