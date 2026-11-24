import * as Crypto from 'expo-crypto'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { nativeLiveActivities, type NativeActivity } from './native-live-activities'
import { registerLiveActivity, unregisterLiveActivity } from './live-activity-operations'
import {
  liveActivityScopeKey,
  saveLiveActivityCohort,
  type LiveActivityCohort
} from './live-activity-overview-enrollment'

export async function registerLiveActivityOverview(
  activity: NativeActivity,
  cohort: LiveActivityCohort,
  clients: ReadonlyMap<string, RpcClient>,
  showNames: boolean,
  current: () => boolean
): Promise<boolean> {
  if (!nativeLiveActivities || !activity.token || !current()) {
    return false
  }
  const environment = await nativeLiveActivities.environment()
  const tokenDigest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    activity.token
  )
  if (cohort.tokenDigest !== tokenDigest) {
    if (cohort.tokenDigest) {
      cohort.controlRevision++
    }
    cohort.tokenDigest = tokenDigest
    if (!(await saveLiveActivityCohort(cohort, current))) {
      return false
    }
  }
  for (const scope of cohort.scopes) {
    if (!current()) {
      return false
    }
    await nativeLiveActivities.storeRoute(`${cohort.overviewId}.${scope.id}`, {
      hostId: scope.hostId,
      ...(scope.executionHost ? { executionHost: scope.executionHost } : {}),
      overviewId: cohort.overviewId,
      scopeId: scope.id,
      activityId: activity.activityId
    })
  }
  const request = async (
    scope: LiveActivityCohort['scopes'][number],
    bootstrap: boolean
  ): Promise<boolean> => {
    const client = clients.get(scope.hostId)
    if (!client || !current()) {
      return false
    }
    const scopeKey = await liveActivityScopeKey(cohort, scope.id)
    const input = {
      schemaVersion: 2 as const,
      activityId: activity.activityId,
      overviewId: cohort.overviewId,
      scopeKey,
      showNames,
      ...(bootstrap
        ? {
            bootstrap: {
              revision: cohort.controlRevision,
              showNames,
              discoveryComplete: cohort.discoveryComplete,
              controlKey: await liveActivityScopeKey(cohort, 'control'),
              token: activity.token,
              apnsEnvironment: environment,
              scopes: cohort.scopes.map((item) => item.id)
            }
          }
        : {})
    }
    if (!current()) {
      return false
    }
    const reply = await registerLiveActivity
      .request(client, input, {
        timeoutMs: 10_000,
        failWhenDisconnected: true,
        ...(scope.executionHost ? { envelope: { executionHost: scope.executionHost } } : {})
      })
      .catch(() => null)
    const accepted = reply ? registerLiveActivity.interpret(reply) : null
    return current() && accepted?.accepted === true && accepted.value.registered
  }
  const ordered = [...cohort.scopes].sort(
    (a, b) =>
      Number(b.id === cohort.coordinatorScopeId) - Number(a.id === cohort.coordinatorScopeId)
  )
  let coordinator: LiveActivityCohort['scopes'][number] | undefined
  for (const scope of ordered) {
    if (!clients.has(scope.hostId)) {
      continue
    }
    if (scope.id !== cohort.coordinatorScopeId) {
      cohort.controlRevision++
      cohort.coordinatorScopeId = scope.id
      if (!(await saveLiveActivityCohort(cohort, current))) {
        return false
      }
    }
    if (await request(scope, true)) {
      coordinator = scope
      break
    }
    if (!current()) {
      return false
    }
  }
  if (!coordinator) {
    return false
  }
  for (const scope of cohort.scopes) {
    if (scope.id !== coordinator.id) {
      await request(scope, false)
    }
    if (!current()) {
      return false
    }
  }
  return true
}

export async function unregisterLiveActivityOverview(
  activityId: string,
  cohort: LiveActivityCohort,
  clients: ReadonlyMap<string, RpcClient>
): Promise<void> {
  await Promise.all(
    cohort.scopes.map(async (scope) => {
      const client = clients.get(scope.hostId)
      if (!client) {
        return
      }
      await unregisterLiveActivity
        .request(
          client,
          { activityId },
          {
            timeoutMs: 5000,
            failWhenDisconnected: true,
            ...(scope.executionHost ? { envelope: { executionHost: scope.executionHost } } : {})
          }
        )
        .catch(() => null)
    })
  )
}
