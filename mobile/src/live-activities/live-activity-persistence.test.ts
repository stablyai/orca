import { registerLiveActivityOverview } from './live-activity-overview-registration'
import { beforeEach, expect, it, vi } from 'vitest'
import * as z from 'zod'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

const backend = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  secrets: new Map<string, string>(),
  writes: 0,
  failWrite: 0,
  failDelete: false,
  catalog: [{ id: 'host-a' }],
  nativeActive: new Set<string>(),
  failNativeEnd: false
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => backend.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      backend.storage.set(key, value)
    },
    removeItem: async (key: string) => {
      backend.storage.delete(key)
    }
  }
}))
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => backend.secrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    backend.writes++
    if (backend.writes === backend.failWrite) {
      throw new Error('Keychain unavailable')
    }
    backend.secrets.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    if (backend.failDelete) {
      throw new Error('Keychain unavailable')
    }
    backend.secrets.delete(key)
  }
}))
vi.mock('expo-crypto', async () => {
  const { createHash, randomUUID } = await import('node:crypto')
  return {
    randomUUID,
    CryptoDigestAlgorithm: { SHA256: 'sha256' },
    digestStringAsync: async (algorithm: string, input: string) =>
      createHash(algorithm).update(input).digest('hex')
  }
})
vi.mock('./native-live-activities', () => ({
  nativeLiveActivities: {
    environment: async () => 'sandbox',
    storeRoute: async () => {},
    end: async (id: string) => {
      if (backend.failNativeEnd) {
        throw new Error('ActivityKit unavailable')
      }
      backend.nativeActive.delete(id)
    },
    forgetRoute: async () => {}
  }
}))
vi.mock('../host-catalog/host-store', () => ({ loadHostCatalog: async () => backend.catalog }))

import {
  cleanupLiveActivitySecrets,
  createLiveActivityCohort,
  discoverLiveActivitySources,
  forgetLiveActivityCohort,
  loadLiveActivityCohort
} from './live-activity-overview-enrollment'
import {
  endLiveActivityOverview,
  isLiveActivityRetiring,
  pendingLiveActivityRetirementHosts,
  retryLiveActivityRetirements,
  unregisterLiveActivityOverview
} from './live-activity-retirement'

function client(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    subscribe: () => () => {},
    onStateChange: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

beforeEach(() => {
  backend.storage.clear()
  backend.secrets.clear()
  backend.writes = 0
  backend.failWrite = 0
  backend.failDelete = false
  backend.catalog = [{ id: 'host-a' }]
  backend.nativeActive.clear()
  backend.failNativeEnd = false
})

it('keeps durable deletion intent across failed allocation and retirement of Keychain secrets', async () => {
  backend.failWrite = 2
  backend.failDelete = true
  await expect(
    createLiveActivityCohort(
      { sources: [{ hostId: 'host-a' }, { hostId: 'host-b' }], complete: true },
      'host-a',
      () => true
    )
  ).rejects.toThrow('Keychain unavailable')
  expect(await loadLiveActivityCohort()).toBeNull()
  expect(backend.secrets.size).toBe(1)
  expect(JSON.parse(backend.storage.get('orca:liveActivitySecretCleanup:v2')!)).toHaveLength(3)
  backend.failDelete = false
  await cleanupLiveActivitySecrets()
  expect(backend.secrets.size).toBe(0)
  const cohort = await createLiveActivityCohort(
    { sources: [{ hostId: 'host-a' }], complete: true },
    'host-a',
    () => true
  )
  expect(cohort).not.toBeNull()
  expect(backend.secrets.size).toBe(2)
  backend.failDelete = true
  await expect(forgetLiveActivityCohort(cohort!.overviewId)).rejects.toThrow('cleanup pending')
  expect(await loadLiveActivityCohort()).toBeNull()
  expect(backend.secrets.size).toBe(2)
  expect(JSON.parse(backend.storage.get('orca:liveActivitySecretCleanup:v2')!)).toHaveLength(2)
  backend.failDelete = false
  await cleanupLiveActivitySecrets()
  expect(backend.secrets.size).toBe(0)
  expect(backend.storage.has('orca:liveActivitySecretCleanup:v2')).toBe(false)
})

it('retains an offline retirement until a decoded acknowledgement removes the host enrollment', async () => {
  const cohort = await createLiveActivityCohort(
    { sources: [{ hostId: 'host-a' }], complete: true },
    'host-a',
    () => true
  )
  const enrollments = new Set(['activity'])
  expect(await unregisterLiveActivityOverview('activity', cohort!, new Map())).toBe(false)
  await forgetLiveActivityCohort(cohort!.overviewId)
  expect(await pendingLiveActivityRetirementHosts()).toEqual(['host-a'])
  expect([...enrollments]).toEqual(['activity'])
  const connected = client(async (_method, params) => {
    const { activityId } = z.object({ activityId: z.string() }).parse(params)
    enrollments.delete(activityId)
    return { id: 'reply', ok: true, result: { unregistered: true } }
  })
  expect(await retryLiveActivityRetirements(new Map([['host-a', connected]]))).toBe(true)
  expect([...enrollments]).toEqual([])
  expect(await pendingLiveActivityRetirementHosts()).toEqual([])
})

it('does not claim complete discovery when a later host disconnects during an earlier relay read', async () => {
  backend.catalog = [{ id: 'host-a' }, { id: 'host-b' }]
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const clients = new Map([
    [
      'host-a',
      client(async () => {
        entered.resolve()
        await release.promise
        return { id: 'a', ok: true, result: { hosts: [] } }
      })
    ],
    [
      'host-b',
      client(async () => {
        throw new Error('Disconnected')
      })
    ]
  ])
  const discovery = discoverLiveActivitySources(clients)
  await entered.promise
  clients.delete('host-b')
  release.resolve()
  expect(await discovery).toEqual({
    sources: [{ hostId: 'host-a' }, { hostId: 'host-b' }],
    complete: false
  })
})

it('keeps a failed non-coordinator enrollment incomplete until retry accepts every source', async () => {
  const cohort = await createLiveActivityCohort(
    { sources: [{ hostId: 'host-a' }, { hostId: 'host-b' }], complete: true },
    'host-a',
    () => true
  )
  let secondAvailable = false
  const enrolled = new Set<string>()
  const clients = new Map(
    ['host-a', 'host-b'].map((id) => [
      id,
      client(async () => {
        const registered = id === 'host-a' || secondAvailable
        if (registered) {
          enrolled.add(id)
        }
        return { id, ok: true, result: { registered } }
      })
    ])
  )
  const activity = {
    activityId: 'activity',
    linkId: cohort!.overviewId,
    token: 'aabb',
    state: 'active'
  }
  expect(await registerLiveActivityOverview(activity, cohort!, clients, false, () => true)).toBe(
    false
  )
  expect([...enrolled]).toEqual(['host-a'])
  secondAvailable = true
  expect(
    await registerLiveActivityOverview(
      activity,
      (await loadLiveActivityCohort())!,
      clients,
      false,
      () => true
    )
  ).toBe(true)
  expect([...enrolled]).toEqual(['host-a', 'host-b'])
})

it('retains a failed native end after remote acknowledgement and retries it without a host', async () => {
  const cohort = await createLiveActivityCohort(
    { sources: [{ hostId: 'host-a' }], complete: true },
    'host-a',
    () => true
  )
  const activity = {
    activityId: 'native-activity',
    linkId: cohort!.overviewId,
    token: 'aabb',
    state: 'active'
  }
  backend.nativeActive.add(activity.activityId)
  backend.failNativeEnd = true
  const connected = client(async () => ({ id: 'reply', ok: true, result: { unregistered: true } }))
  expect(await endLiveActivityOverview(activity, cohort, new Map([['host-a', connected]]))).toBe(
    false
  )
  expect(await isLiveActivityRetiring(activity.activityId)).toBe(true)
  expect(backend.nativeActive.has(activity.activityId)).toBe(true)
  backend.failNativeEnd = false
  expect(await retryLiveActivityRetirements(new Map())).toBe(true)
  expect(await isLiveActivityRetiring(activity.activityId)).toBe(false)
  expect(backend.nativeActive.size).toBe(0)
})
