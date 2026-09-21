import { afterEach, describe, expect, it } from 'vitest'
import {
  GENERAL_CAP,
  GitAdmissionScheduler,
  MAX_GIT_CHILDREN,
  NETWORK_CAP,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests,
  acquireGitAdmission
} from './git-subprocess-admission'
import type { GitAdmissionEvent } from './git-admission-state'

const local = (tier: 'interactive' | 'status' | 'background' = 'status') => ({
  args: ['status'],
  cwd: '/repo',
  tier
})

const schedulerWithOneSlot = (now: () => number = () => 0): GitAdmissionScheduler =>
  new GitAdmissionScheduler({
    generalCap: 1,
    networkCap: 1,
    generalHeadroom: 1,
    networkHeadroom: 1,
    routeCap: 1,
    routeHeadroom: 1,
    now
  })

afterEach(() => {
  delete process.env.ORCA_GIT_ADMISSION_DISABLED
  _resetGitAdmissionForTests()
})

describe('GitAdmissionScheduler', () => {
  it('pins the global base budgets and absolute maximum', () => {
    expect(GENERAL_CAP).toBeGreaterThanOrEqual(2)
    expect(GENERAL_CAP).toBeLessThanOrEqual(4)
    expect(NETWORK_CAP).toBe(3)
    expect(MAX_GIT_CHILDREN).toBe(10)
  })

  it('keeps base and headroom counters separate and grants interactive all-headroom', async () => {
    const scheduler = schedulerWithOneSlot()
    const base = await scheduler.acquire(local('background'))
    const interactive = await scheduler.acquire({
      ...local('interactive'),
      cwd: 'C:\\repo',
      wslDistro: 'Ubuntu'
    })

    expect(scheduler.snapshot().budgets).toMatchObject({
      general: { baseUsed: 1, headroomUsed: 1 },
      'route:general:wsl:ubuntu': { baseUsed: 0, headroomUsed: 1 }
    })

    base.release()
    expect(scheduler.snapshot().budgets.general).toEqual({ baseUsed: 0, headroomUsed: 1 })
    interactive.release()
    expect(scheduler.snapshot().budgets.general).toEqual({ baseUsed: 0, headroomUsed: 0 })
  })

  it('partitions network and general budgets globally and per route', async () => {
    const scheduler = schedulerWithOneSlot()
    const fetch = await scheduler.acquire({
      args: ['fetch'],
      cwd: 'C:\\repo',
      wslDistro: 'Ubuntu',
      tier: 'background'
    })
    const status = await scheduler.acquire({
      args: ['status'],
      cwd: 'C:\\repo',
      wslDistro: 'Ubuntu',
      tier: 'status'
    })

    expect(scheduler.snapshot().budgets).toMatchObject({
      network: { baseUsed: 1, headroomUsed: 0 },
      general: { baseUsed: 1, headroomUsed: 0 },
      'route:network:wsl:ubuntu': { baseUsed: 1, headroomUsed: 0 },
      'route:general:wsl:ubuntu': { baseUsed: 1, headroomUsed: 0 }
    })
    fetch.release()
    status.release()
  })

  it('uses network and route headroom for an interactive push', async () => {
    const scheduler = schedulerWithOneSlot()
    const fetch = await scheduler.acquire({
      args: ['fetch'],
      cwd: '\\\\server\\repo',
      tier: 'background'
    })
    const push = await scheduler.acquire({
      args: ['push'],
      cwd: '\\\\server\\repo',
      tier: 'interactive'
    })

    expect(scheduler.snapshot().budgets).toMatchObject({
      network: { baseUsed: 1, headroomUsed: 1 },
      'route:network:unc:server': { baseUsed: 1, headroomUsed: 1 }
    })
    fetch.release()
    push.release()
  })

  it('admits same-route interactive work when general and route bases are full', async () => {
    const scheduler = new GitAdmissionScheduler({
      generalCap: 2,
      generalHeadroom: 2,
      routeCap: 2,
      routeHeadroom: 1
    })
    const request = { cwd: 'C:\\repo', wslDistro: 'Ubuntu' }
    const background = await Promise.all([
      scheduler.acquire({ ...request, args: ['status'], tier: 'background' }),
      scheduler.acquire({ ...request, args: ['status'], tier: 'background' })
    ])
    const interactive = await scheduler.acquire({
      ...request,
      args: ['status'],
      tier: 'interactive'
    })

    expect(scheduler.snapshot().budgets).toMatchObject({
      general: { baseUsed: 2, headroomUsed: 1 },
      'route:general:wsl:ubuntu': { baseUsed: 2, headroomUsed: 1 }
    })
    background.forEach((grant) => grant.release())
    interactive.release()
  })

  it('keeps status isolated from wedged route fetches and reserves push headroom', async () => {
    const scheduler = new GitAdmissionScheduler()
    const request = { cwd: 'C:\\repo', wslDistro: 'Ubuntu' }
    const fetches = await Promise.all([
      scheduler.acquire({ ...request, args: ['fetch'], tier: 'background' }),
      scheduler.acquire({ ...request, args: ['fetch'], tier: 'background' })
    ])
    const thirdFetch = await scheduler.acquire({
      args: ['fetch'],
      cwd: '/other-repo',
      tier: 'background'
    })
    const status = await scheduler.acquire({ ...request, args: ['status'], tier: 'status' })
    const push = await scheduler.acquire({ ...request, args: ['push'], tier: 'interactive' })

    expect(scheduler.snapshot().budgets).toMatchObject({
      network: { baseUsed: 3, headroomUsed: 1 },
      general: { baseUsed: 1, headroomUsed: 0 },
      'route:network:wsl:ubuntu': { baseUsed: 2, headroomUsed: 1 },
      'route:general:wsl:ubuntu': { baseUsed: 1, headroomUsed: 0 }
    })
    fetches.forEach((grant) => grant.release())
    thirdFetch.release()
    status.release()
    push.release()
  })

  it('ages background work ahead of fresh base waiters without granting it headroom', async () => {
    let now = 0
    const scheduler = schedulerWithOneSlot(() => now)
    const running = await scheduler.acquire(local('status'))
    const order: string[] = []
    const backgroundPromise = scheduler.acquire(local('background')).then((grant) => {
      order.push('background')
      return grant
    })
    now = 30_000
    const headroom = await scheduler.acquire(local('interactive'))
    const freshPromise = scheduler.acquire(local('interactive')).then((grant) => {
      order.push('fresh')
      return grant
    })

    running.release()
    const background = await backgroundPromise
    expect(order).toEqual(['background'])
    expect(scheduler.snapshot().queued).toBe(1)

    background.release()
    const fresh = await freshPromise
    expect(order).toEqual(['background', 'fresh'])
    headroom.release()
    fresh.release()
  })

  it('keeps a route base slot free when fresh interactive work needs global headroom', async () => {
    let now = 0
    const scheduler = schedulerWithOneSlot(() => now)
    const running = await scheduler.acquire(local('status'))
    const agedPromise = scheduler.acquire({
      ...local('background'),
      cwd: 'C:\\repo',
      wslDistro: 'Ubuntu'
    })
    now = 30_000
    const interactive = await scheduler.acquire({
      ...local('interactive'),
      cwd: 'C:\\repo',
      wslDistro: 'Ubuntu'
    })

    expect(scheduler.snapshot().budgets['route:general:wsl:ubuntu']).toEqual({
      baseUsed: 0,
      headroomUsed: 1
    })
    running.release()
    const aged = await agedPromise
    expect(scheduler.snapshot().budgets['route:general:wsl:ubuntu']).toEqual({
      baseUsed: 1,
      headroomUsed: 1
    })
    aged.release()
    interactive.release()
  })

  it('does not let a saturated route delay local-disk work below the general cap', async () => {
    const scheduler = new GitAdmissionScheduler({
      generalCap: 3,
      generalHeadroom: 1,
      routeCap: 1,
      routeHeadroom: 1
    })
    const routed = await scheduler.acquire({
      ...local('background'),
      cwd: 'C:\\repo',
      wslDistro: 'Ubuntu'
    })
    const queuedRoute = scheduler.acquire({
      ...local('background'),
      cwd: 'C:\\other',
      wslDistro: 'Ubuntu'
    })
    const localDisk = await scheduler.acquire({ ...local('status'), cwd: 'C:\\local' })

    expect(scheduler.snapshot().queued).toBe(1)
    localDisk.release()
    routed.release()
    const secondRoute = await queuedRoute
    secondRoute.release()
  })

  it('admits local-disk work beside two saturated-route children below the cap', async () => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 4, routeCap: 2 })
    const routed = await Promise.all([
      scheduler.acquire({
        ...local('background'),
        cwd: 'C:\\repo',
        wslDistro: 'Ubuntu'
      }),
      scheduler.acquire({
        ...local('background'),
        cwd: 'C:\\other',
        wslDistro: 'Ubuntu'
      })
    ])
    const localDisk = await scheduler.acquire({ ...local('status'), cwd: 'C:\\local' })

    expect(scheduler.snapshot()).toMatchObject({
      queued: 0,
      budgets: {
        general: { baseUsed: 3, headroomUsed: 0 },
        'route:general:wsl:ubuntu': { baseUsed: 2, headroomUsed: 0 }
      }
    })
    routed.forEach((grant) => grant.release())
    localDisk.release()
  })

  it('removes an aborted queued waiter without changing occupancy', async () => {
    const scheduler = schedulerWithOneSlot()
    const running = await scheduler.acquire(local())
    const controller = new AbortController()
    const queued = scheduler.acquire({ ...local(), signal: controller.signal })
    controller.abort()

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(scheduler.snapshot()).toMatchObject({
      queued: 0,
      budgets: { general: { baseUsed: 1, headroomUsed: 0 } }
    })
    running.release()
  })

  it('bounds canceled candidate storage while the only permit stays saturated', async () => {
    const scheduler = schedulerWithOneSlot()
    const running = await scheduler.acquire(local())
    const canceled: Promise<void>[] = []

    for (let index = 0; index < 4_000; index += 1) {
      const controller = new AbortController()
      const request = scheduler.acquire({ ...local(), signal: controller.signal }).then(
        () => undefined,
        (error) => expect(error).toMatchObject({ name: 'AbortError' })
      )
      controller.abort()
      canceled.push(request)
    }
    await Promise.all(canceled)

    expect(scheduler.snapshot().queued).toBe(0)
    expect(scheduler.snapshot().candidateCount).toBeLessThanOrEqual(64)
    running.release()
    expect(scheduler.snapshot().candidateCount).toBe(0)
  })

  it('does not decrement for an already-aborted signal with a free slot', async () => {
    const scheduler = schedulerWithOneSlot()
    const controller = new AbortController()
    controller.abort()

    await expect(
      scheduler.acquire({ ...local(), signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(scheduler.snapshot()).toEqual({
      queued: 0,
      queuedWaiters: [],
      candidateCount: 0,
      budgets: {}
    })
  })

  it('returns a grant selected in the same tick when abort wins delivery', async () => {
    const scheduler = schedulerWithOneSlot()
    const running = await scheduler.acquire(local())
    const controller = new AbortController()
    const queued = scheduler.acquire({ ...local(), signal: controller.signal })

    running.release()
    controller.abort()

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(scheduler.snapshot()).toMatchObject({
      queued: 0,
      budgets: { general: { baseUsed: 0, headroomUsed: 0 } }
    })
  })

  it('preserves FIFO after removing an aborted interactive waiter', async () => {
    const scheduler = schedulerWithOneSlot()
    const running = await scheduler.acquire(local())
    const firstController = new AbortController()
    const first = scheduler.acquire({ ...local('interactive'), signal: firstController.signal })
    const second = scheduler.acquire(local('interactive'))
    const third = scheduler.acquire(local('interactive'))
    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })

    running.release()
    const secondGrant = await second
    secondGrant.release()
    const thirdGrant = await third
    thirdGrant.release()
  })

  it('completes a background burst while interactive work uses reserved headroom', async () => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 2, generalHeadroom: 1 })
    const order: number[] = []
    const background = Array.from({ length: 20 }, (_, index) =>
      scheduler.acquire(local('background')).then((grant) => {
        order.push(index)
        grant.release()
      })
    )
    let interactiveRan = false
    const interactive = scheduler.acquire(local('interactive')).then((grant) => {
      interactiveRan = true
      grant.release()
    })

    await Promise.all([...background, interactive])
    expect(interactiveRan).toBe(true)
    expect(order).toEqual(Array.from({ length: 20 }, (_, index) => index))
  })

  it('drains a large saturated FIFO burst without retaining settled waiters', async () => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
    const running = await scheduler.acquire(local('status'))
    const count = 4_000
    const order: number[] = []
    const queued = Array.from({ length: count }, (_, index) =>
      scheduler.acquire(local('background')).then((grant) => {
        order.push(index)
        grant.release()
      })
    )

    expect(scheduler.snapshot().queued).toBe(count)
    running.release()
    await Promise.all(queued)

    expect(order).toEqual(Array.from({ length: count }, (_, index) => index))
    expect(scheduler.snapshot()).toMatchObject({ queued: 0, queuedWaiters: [] })
  })

  it('skips a 4k saturated-route lane without rescanning its blocked prefix', async () => {
    const scheduler = new GitAdmissionScheduler({
      generalCap: 2,
      generalHeadroom: 0,
      routeCap: 1,
      routeHeadroom: 0
    })
    const routedRunning = await scheduler.acquire({
      ...local('background'),
      wslDistro: 'Ubuntu'
    })
    const localRunning = await scheduler.acquire(local('background'))
    let abortedReads = 0
    const signal = {
      get aborted() {
        abortedReads += 1
        return false
      },
      addEventListener: () => {},
      removeEventListener: () => {}
    } as unknown as AbortSignal
    const count = 4_000
    const routed = Array.from({ length: count }, () =>
      scheduler
        .acquire({ ...local('background'), wslDistro: 'Ubuntu', signal })
        .then((grant) => grant.release())
    )
    const localWork = Array.from({ length: count }, () =>
      scheduler.acquire({ ...local('background'), signal }).then((grant) => grant.release())
    )
    abortedReads = 0

    localRunning.release()
    await Promise.all(localWork)
    expect(scheduler.snapshot().queued).toBe(count)

    routedRunning.release()
    await Promise.all(routed)
    expect(abortedReads).toBeLessThan(30_000)
    expect(scheduler.snapshot()).toMatchObject({ queued: 0, queuedWaiters: [] })
  })

  it('selects one eligible route without scanning thousands of saturated routes', async () => {
    const routeCount = 2_000
    const scheduler = new GitAdmissionScheduler({
      generalCap: routeCount,
      generalHeadroom: 0,
      routeCap: 1,
      routeHeadroom: 0
    })
    const running = await Promise.all(
      Array.from({ length: routeCount }, (_, index) =>
        scheduler.acquire({ ...local('background'), wslDistro: `distro-${index}` })
      )
    )
    let aborted = false
    let abortedReads = 0
    const abortListeners = new Set<() => void>()
    const signal = {
      get aborted() {
        abortedReads += 1
        return aborted
      },
      addEventListener: (_event: string, listener: () => void) => abortListeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => abortListeners.delete(listener)
    } as unknown as AbortSignal
    const queued = Array.from({ length: routeCount }, (_, index) =>
      scheduler
        .acquire({ ...local('background'), wslDistro: `distro-${index}`, signal })
        .then((grant) => grant.release())
    )
    abortedReads = 0

    running.at(-1)?.release()
    await queued.at(-1)

    expect(abortedReads).toBeLessThanOrEqual(2)
    expect(scheduler.snapshot().queued).toBe(routeCount - 1)

    aborted = true
    for (const listener of abortListeners) {
      listener()
    }
    await Promise.allSettled(queued.slice(0, -1))
    running.slice(0, -1).forEach((grant) => grant.release())
    expect(scheduler.snapshot()).toMatchObject({ queued: 0, queuedWaiters: [] })
  })

  it('captures killswitch state in each release closure', async () => {
    const scheduler = schedulerWithOneSlot()
    _resetGitAdmissionForTests(scheduler)
    process.env.ORCA_GIT_ADMISSION_DISABLED = '1'
    const bypass = await acquireGitAdmission(local())
    delete process.env.ORCA_GIT_ADMISSION_DISABLED
    bypass.release()
    expect(_gitAdmissionSnapshotForTests().budgets.general).toBeUndefined()

    const admitted = await acquireGitAdmission(local())
    process.env.ORCA_GIT_ADMISSION_DISABLED = '1'
    admitted.release()
    expect(_gitAdmissionSnapshotForTests().budgets.general).toEqual({
      baseUsed: 0,
      headroomUsed: 0
    })
  })

  it('publishes monotonic grant and release events with cap metadata', async () => {
    const events: GitAdmissionEvent[] = []
    const scheduler = new GitAdmissionScheduler({
      generalCap: 1,
      generalHeadroom: 1,
      routeCap: 1,
      routeHeadroom: 1,
      onAdmissionEvent: (event) => events.push(event)
    })
    const background = await scheduler.acquire({
      ...local('background'),
      cwd: 'C:\\repo',
      wslDistro: 'Ubuntu'
    })
    const interactive = await scheduler.acquire({
      ...local('interactive'),
      cwd: 'C:\\repo',
      wslDistro: 'Ubuntu'
    })
    background.release()
    interactive.release()

    expect(events.map(({ sequence, phase, slotKind }) => [sequence, phase, slotKind])).toEqual([
      [0, 'grant', 'base'],
      [1, 'grant', 'headroom'],
      [2, 'release', 'base'],
      [3, 'release', 'headroom']
    ])
    expect(events[1]).toMatchObject({
      tier: 'interactive',
      admissionClass: 'general',
      route: 'wsl:ubuntu',
      queued: 0
    })
    expect(events[1]?.budgets).toEqual(
      expect.arrayContaining([
        {
          key: 'general',
          baseCapacity: 1,
          headroomCapacity: 1,
          baseUsed: 1,
          headroomUsed: 1
        },
        {
          key: 'route:general:wsl:ubuntu',
          baseCapacity: 1,
          headroomCapacity: 1,
          baseUsed: 1,
          headroomUsed: 1
        }
      ])
    )
  })
})
