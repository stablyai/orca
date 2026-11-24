import { backend, client } from './live-activity-persistence.test-fixture'
import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as z from 'zod'
import type { LiveActivityCohort } from './live-activity-overview-enrollment'
import {
  endLiveActivityOverview,
  pendingLiveActivityRetirementHosts,
  retryLiveActivityRetirements,
  unregisterLiveActivityOverview
} from './live-activity-retirement'

function cohort(hostIds: string[]): LiveActivityCohort {
  return {
    overviewId: randomUUID(),
    coordinatorScopeId: 'a'.repeat(64),
    controlRevision: 1,
    discoveryComplete: true,
    scopes: hostIds.map((hostId) => ({ hostId, id: 'a'.repeat(64) }))
  }
}

it('ends native activities despite older remote failures and gives later remote retirements a turn', async () => {
  const initial = cohort(['host-a'])
  const enrollments = new Set(['older-0', 'older-1', 'older-2', 'older-3', 'later'])
  const rejecting = client(async () => ({ id: 'reply', ok: true, result: { unregistered: false } }))
  const accepting = client(async (_method, raw) => {
    const { activityId } = z.object({ activityId: z.string() }).parse(raw)
    enrollments.delete(activityId)
    return { id: 'reply', ok: true, result: { unregistered: true } }
  })
  for (let i = 0; i < 4; i++) {
    await unregisterLiveActivityOverview(`older-${i}`, initial, new Map())
  }
  const later = cohort(['host-b'])
  backend.nativeActive.add('later')
  const clients = new Map([
    ['host-a', rejecting],
    ['host-b', accepting]
  ])
  await endLiveActivityOverview(
    { activityId: 'later', linkId: later.overviewId, token: 'aabb', state: 'active' },
    later,
    clients
  )
  expect(backend.nativeActive.size).toBe(0)
  await retryLiveActivityRetirements(clients)
  expect([...enrollments]).toEqual(['older-0', 'older-1', 'older-2', 'older-3'])
  expect(await pendingLiveActivityRetirementHosts()).toEqual(['host-a'])
})

it('recovers a late enrollment for a scope already acknowledged in a pending retirement', async () => {
  const current = cohort(['host-a', 'host-b'])
  const live = new Set(['host-a'])
  const a = client(async () => {
    live.delete('host-a')
    return { id: 'reply', ok: true, result: { unregistered: true } }
  })
  await unregisterLiveActivityOverview('activity', current, new Map([['host-a', a]]))
  expect([...live]).toEqual([])
  expect(await pendingLiveActivityRetirementHosts()).toEqual(['host-b'])
  live.add('host-a')
  await unregisterLiveActivityOverview('activity', current, new Map())
  expect(new Set(await pendingLiveActivityRetirementHosts())).toEqual(new Set(['host-a', 'host-b']))
  await retryLiveActivityRetirements(new Map([['host-a', a]]))
  expect([...live]).toEqual([])
  expect(await pendingLiveActivityRetirementHosts()).toEqual(['host-b'])
})

it('rejects an oversized scope union without corrupting the durable retirement record', async () => {
  const current = cohort(Array.from({ length: 32 }, (_, i) => `host-${i}`))
  await unregisterLiveActivityOverview('activity', current, new Map())
  await expect(
    unregisterLiveActivityOverview(
      'activity',
      { ...current, scopes: cohort(['extra']).scopes },
      new Map()
    )
  ).rejects.toThrow('Too many Live Activity retirement scopes')
  expect(await pendingLiveActivityRetirementHosts()).toEqual(
    Array.from({ length: 32 }, (_, i) => `host-${i}`)
  )
})
