import { backend, client } from './live-activity-persistence.test-fixture'
import { registerLiveActivityOverview } from './live-activity-overview-registration'
import { expect, it } from 'vitest'
import * as z from 'zod'

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

it('recovers active Keychain credentials when the cohort metadata becomes malformed', async () => {
  await createLiveActivityCohort(
    { sources: [{ hostId: 'host-a' }], complete: true },
    'host-a',
    () => true
  )
  expect(backend.secrets.size).toBe(2)
  backend.storage.set('orca:liveActivityOverview:v2', '{invalid')
  await cleanupLiveActivitySecrets()
  expect(backend.secrets.size).toBe(0)
  expect(backend.storage.has('orca:liveActivitySecretCleanup:v2')).toBe(false)
})

it('bootstraps through the next coordinator when the saved coordinator key cannot be read', async () => {
  const cohort = await createLiveActivityCohort(
    { sources: [{ hostId: 'host-a' }, { hostId: 'host-b' }], complete: true },
    'host-a',
    () => true
  )
  backend.secrets.delete(`orca.activity.${cohort!.overviewId}.${cohort!.coordinatorScopeId}`)
  const enrolled = new Set<string>()
  const clients = new Map(
    ['host-a', 'host-b'].map((id) => [
      id,
      client(async () => {
        enrolled.add(id)
        return { id, ok: true, result: { registered: true } }
      })
    ])
  )
  expect(
    await registerLiveActivityOverview(
      { activityId: 'activity', linkId: cohort!.overviewId, token: 'aabb', state: 'active' },
      cohort!,
      clients,
      false,
      () => true
    )
  ).toBe(false)
  expect([...enrolled]).toEqual(['host-b'])
  expect((await loadLiveActivityCohort())?.coordinatorScopeId).toBe(cohort!.scopes[1].id)
})
