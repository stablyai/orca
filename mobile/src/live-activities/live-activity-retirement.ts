import AsyncStorage from '@react-native-async-storage/async-storage'
import * as z from 'zod'
import { runKeyedSerializedOperation } from '../../../src/shared/concurrency/keyed-serialized-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  loadLiveActivityCohort,
  forgetLiveActivityCohort,
  type LiveActivityCohort
} from './live-activity-overview-enrollment'
import {
  setLiveActivityDeliveryFailed,
  setLiveActivityCleanupPending
} from './live-activity-delivery-status'
import { nativeLiveActivities, type NativeActivity } from './native-live-activities'
import { unregisterLiveActivity } from './live-activity-operations'
import { notifyLiveActivityPreferences } from './live-activity-preferences'

const KEY = 'orca:liveActivityRetirements:v2'
const writes = new Map<string, Promise<void>>()
const recordsSchema = z.array(
  z.object({
    activityId: z.string().min(1).max(128),
    overviewId: z.uuid(),
    expiresAt: z.number().positive(),
    nativePending: z.boolean().default(false),
    scopes: z.array(z.object({ hostId: z.string(), executionHost: z.string().optional() })).max(32)
  })
)
type Retirement = z.infer<typeof recordsSchema>[number]

async function readRetirements(): Promise<Retirement[]> {
  const raw = await AsyncStorage.getItem(KEY)
  return recordsSchema
    .parse(raw ? JSON.parse(raw) : [])
    .filter((item) => item.expiresAt > Date.now())
}

async function saveRetirements(records: Retirement[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(records))
  notifyLiveActivityPreferences()
}

async function flushRetirements(
  records: Retirement[],
  clients: ReadonlyMap<string, RpcClient>
): Promise<boolean> {
  const ready = records
    .filter(
      (record) =>
        record.nativePending ||
        record.scopes.some((scope) => clients.get(scope.hostId)?.getState() === 'connected')
    )
    .slice(0, 4)
  await Promise.all(
    ready.map(async (record) => {
      if (record.nativePending && nativeLiveActivities) {
        try {
          await nativeLiveActivities.end(record.activityId)
          await nativeLiveActivities.forgetRoute(record.overviewId)
          record.nativePending = false
        } catch {
          /* Retain the native retirement for foreground retry. */
        }
      }
      const pending = await Promise.all(
        record.scopes.map(async (scope) => {
          const client = clients.get(scope.hostId)
          if (!client || client.getState() !== 'connected') {
            return scope
          }
          const reply = await unregisterLiveActivity
            .request(
              client,
              { activityId: record.activityId },
              {
                timeoutMs: 5000,
                failWhenDisconnected: true,
                ...(scope.executionHost ? { envelope: { executionHost: scope.executionHost } } : {})
              }
            )
            .catch(() => null)
          const result = reply ? unregisterLiveActivity.interpret(reply) : null
          return result?.accepted && result.value.unregistered ? null : scope
        })
      )
      record.scopes = pending.filter((scope) => scope !== null)
    })
  )
  const remaining = records.filter((record) => record.nativePending || record.scopes.length > 0)
  await saveRetirements(remaining)
  return remaining.length === 0
}

export function retryLiveActivityRetirements(
  clients: ReadonlyMap<string, RpcClient>
): Promise<boolean> {
  return runKeyedSerializedOperation(writes, KEY, async () =>
    flushRetirements(await readRetirements(), clients)
  )
}

export function pendingLiveActivityRetirementHosts(): Promise<string[]> {
  return runKeyedSerializedOperation(writes, KEY, async () => [
    ...new Set(
      (await readRetirements()).flatMap((record) => record.scopes.map((scope) => scope.hostId))
    )
  ])
}

function enqueueRetirement(
  activityId: string,
  overviewId: string,
  scopes: Retirement['scopes'],
  nativePending: boolean,
  clients: ReadonlyMap<string, RpcClient>
): Promise<boolean> {
  return runKeyedSerializedOperation(writes, KEY, async () => {
    const records = await readRetirements()
    const existing = records.find(
      (record) => record.activityId === activityId && record.overviewId === overviewId
    )
    if (existing) {
      existing.nativePending ||= nativePending
    } else {
      records.push({
        activityId,
        overviewId,
        expiresAt: Date.now() + 8 * 60 * 60_000,
        scopes,
        nativePending
      })
    }
    await saveRetirements(records)
    return flushRetirements(records, clients)
  })
}

export function isLiveActivityRetiring(activityId: string): Promise<boolean> {
  return runKeyedSerializedOperation(writes, KEY, async () =>
    (await readRetirements()).some(
      (record) => record.activityId === activityId && record.nativePending
    )
  )
}

export function unregisterLiveActivityOverview(
  activityId: string,
  cohort: LiveActivityCohort,
  clients: ReadonlyMap<string, RpcClient>
): Promise<boolean> {
  return enqueueRetirement(activityId, cohort.overviewId, cohort.scopes, false, clients)
}

export async function endLiveActivityOverview(
  activity: NativeActivity,
  cohort: LiveActivityCohort | null,
  clients: ReadonlyMap<string, RpcClient>
): Promise<boolean> {
  try {
    return await enqueueRetirement(
      activity.activityId,
      activity.linkId,
      cohort?.overviewId === activity.linkId ? cohort.scopes : [],
      true,
      clients
    )
  } catch (error) {
    await nativeLiveActivities?.end(activity.activityId).catch(() => undefined)
    throw error
  }
}

export async function retireCurrentLiveActivityOverview(
  hosts: ReadonlyMap<string, RpcClient>
): Promise<void> {
  setLiveActivityDeliveryFailed(false)
  const cohort = await loadLiveActivityCohort()
  let complete = true
  let retained = false
  for (const activity of (await nativeLiveActivities?.activities()) ?? []) {
    try {
      complete = (await endLiveActivityOverview(activity, cohort, hosts)) && complete
    } catch {
      retained = true
      complete = false
    }
  }
  if (!retained) {
    await forgetLiveActivityCohort(cohort?.overviewId)
  }
  setLiveActivityCleanupPending(!complete)
}
