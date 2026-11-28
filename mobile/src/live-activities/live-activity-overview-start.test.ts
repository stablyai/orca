import { backend, client } from './live-activity-persistence.test-fixture'
import { expect, it } from 'vitest'
import {
  createLiveActivityCohort,
  loadLiveActivityCohort
} from './live-activity-overview-enrollment'
import { endLiveActivityOverview } from './live-activity-retirement'
import { startLiveActivityOverview } from './live-activity-overview-start'

const seed = { worktreeId: 'folder:workspace', paneKey: 'pane', turnKey: 'turn' }

it('does not report tracking by reusing a native card pending retirement', async () => {
  backend.storage.set('orca:liveActivities', JSON.stringify({ enabled: true, showNames: false }))
  const cohort = await createLiveActivityCohort(
    { sources: [{ hostId: 'host-a' }], complete: true },
    'host-a',
    () => true
  )
  backend.overviewId = cohort!.overviewId
  backend.nativeActive.add('activity')
  backend.failNativeEnd = true
  await endLiveActivityOverview(
    { activityId: 'activity', linkId: cohort!.overviewId, token: 'aabb', state: 'active' },
    cohort,
    new Map()
  )
  expect(await startLiveActivityOverview('host-a', seed, new Map(), () => true)).toBeNull()
  expect([...backend.nativeActive]).toEqual(['activity'])
})

it('does not discover or allocate a replacement after authorization backgrounds the app', async () => {
  backend.storage.set('orca:liveActivities', JSON.stringify({ enabled: true, showNames: false }))
  backend.backgroundOnAuthorization = true
  const host = client(async () => ({ id: 'reply', ok: true, result: { hosts: [] } }))
  expect(
    await startLiveActivityOverview('host-a', seed, new Map([['host-a', host]]), () => true)
  ).toBeNull()
  expect(await loadLiveActivityCohort()).toBeNull()
  expect([...backend.nativeActive]).toEqual([])
  expect(backend.storage.has('orca:liveActivitySources:v2')).toBe(false)
})
