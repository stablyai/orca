import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WATCHER_PROCESS_EXIT_DEADLINE_MS } from './parcel-watcher-child-termination'
import {
  MAX_PHYSICAL_WATCHER_CHILDREN,
  resetWatcherChildRegistryForTest
} from './parcel-watcher-child-registry'
import {
  acknowledgeWatcherSubscribe,
  currentWatcherChild,
  FakeWatcherChild,
  trackPromiseSettlement
} from './parcel-watcher-process-test-child'
import type { WatcherProcessSupervisor } from './parcel-watcher-process-supervisor'

const { existsSyncMock, forkMock, mkdtempSyncMock, rmSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  forkMock: vi.fn(),
  mkdtempSyncMock: vi.fn(() => '/tmp/orca-watcher-capacity-supervisor-test'),
  rmSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdtempSync: mkdtempSyncMock,
  rmSync: rmSyncMock
}))

import { createWatcherProcessSupervisor } from './parcel-watcher-process'

const supervisors: WatcherProcessSupervisor[] = []

function createSupervisor(): WatcherProcessSupervisor {
  const supervisor = createWatcherProcessSupervisor()
  supervisors.push(supervisor)
  return supervisor
}

function currentChild(): FakeWatcherChild {
  return currentWatcherChild(forkMock)
}

describe('WatcherProcessSupervisor capacity wait', () => {
  beforeEach(() => {
    resetWatcherChildRegistryForTest()
    vi.stubEnv('VITEST', '')
    existsSyncMock.mockReturnValue(true)
    forkMock.mockImplementation(() => new FakeWatcherChild())
  })

  afterEach(() => {
    for (const supervisor of supervisors.splice(0)) {
      supervisor.dispose()
    }
    resetWatcherChildRegistryForTest()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('shares one released slot across same-supervisor capacity waiters', async () => {
    vi.useFakeTimers()
    const pending: Promise<unknown>[] = []
    const children: FakeWatcherChild[] = []
    for (let index = 0; index < MAX_PHYSICAL_WATCHER_CHILDREN; index++) {
      const supervisor = createSupervisor()
      const controller = new AbortController()
      const subscription = supervisor.subscribe(
        `/stuck-${index}`,
        vi.fn(),
        {},
        {
          signal: controller.signal
        }
      )
      pending.push(subscription.catch((error) => error))
      const child = currentChild()
      children.push(child)
      const id = child.sent.at(-1)?.id
      child.emit('message', { op: 'subscribe-started', id })
      controller.abort()
      child.emit('message', { op: 'cancel-requires-restart', id })
    }
    expect(forkMock).toHaveBeenCalledTimes(MAX_PHYSICAL_WATCHER_CHILDREN)

    const extraSupervisor = createSupervisor()
    const firstExtra = extraSupervisor.subscribe('/over-cap-a', vi.fn(), {})
    const secondExtra = extraSupervisor.subscribe('/over-cap-b', vi.fn(), {})
    const firstSettled = trackPromiseSettlement(firstExtra)
    const secondSettled = trackPromiseSettlement(secondExtra)
    await Promise.resolve()
    expect(firstSettled()).toBe(false)
    expect(secondSettled()).toBe(false)
    await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_EXIT_DEADLINE_MS)
    await Promise.all(pending)

    expect(forkMock).toHaveBeenCalledTimes(MAX_PHYSICAL_WATCHER_CHILDREN)
    expect(children.every((child) => child.listenerCount('exit') === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    children[0].emit('exit', 0, null)
    await vi.waitFor(() =>
      expect(forkMock).toHaveBeenCalledTimes(MAX_PHYSICAL_WATCHER_CHILDREN + 1)
    )
    const replacement = currentChild()
    const subscribeMessages = replacement.sent.filter(({ op }) => op === 'subscribe')
    expect(subscribeMessages.map(({ dir }) => dir)).toEqual(['/over-cap-a', '/over-cap-b'])
    acknowledgeWatcherSubscribe(replacement, 0)
    acknowledgeWatcherSubscribe(replacement, 1)
    await expect(Promise.all([firstExtra, secondExtra])).resolves.toHaveLength(2)

    const blockedSupervisor = createSupervisor()
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstBlocked = blockedSupervisor.subscribe(
      '/cancelled-over-cap-a',
      vi.fn(),
      {},
      {
        signal: firstController.signal
      }
    )
    const secondBlocked = blockedSupervisor.subscribe(
      '/cancelled-over-cap-b',
      vi.fn(),
      {},
      {
        signal: secondController.signal
      }
    )
    await Promise.resolve()
    expect(forkMock).toHaveBeenCalledTimes(MAX_PHYSICAL_WATCHER_CHILDREN + 1)
    firstController.abort()
    await expect(firstBlocked).rejects.toMatchObject({ code: 'subscribe_aborted' })
    expect(trackPromiseSettlement(secondBlocked)()).toBe(false)
    secondController.abort()
    await expect(secondBlocked).rejects.toMatchObject({ code: 'subscribe_aborted' })

    const racedDisposeSupervisor = createSupervisor()
    const racedDisposeWait = racedDisposeSupervisor.subscribe('/raced-dispose', vi.fn(), {})
    racedDisposeSupervisor.dispose()
    await expect(racedDisposeWait).rejects.toMatchObject({ code: 'supervisor_disposed' })

    const activeDisposeSupervisor = createSupervisor()
    const activeDisposeWait = activeDisposeSupervisor.subscribe('/active-dispose', vi.fn(), {})
    await Promise.resolve()
    activeDisposeSupervisor.dispose()
    await expect(activeDisposeWait).rejects.toMatchObject({ code: 'supervisor_disposed' })

    children[1].emit('exit', 0, null)
    await Promise.resolve()
    await Promise.resolve()
    expect(forkMock).toHaveBeenCalledTimes(MAX_PHYSICAL_WATCHER_CHILDREN + 1)
  })

  it('keeps waiting when crash recovery reclaims the announced slot', async () => {
    const children: FakeWatcherChild[] = []
    for (let index = 0; index < MAX_PHYSICAL_WATCHER_CHILDREN; index++) {
      const supervisor = createSupervisor()
      const subscription = supervisor.subscribe(`/active-${index}`, vi.fn(), {})
      const child = currentChild()
      children.push(child)
      acknowledgeWatcherSubscribe(child)
      await subscription
    }

    const waitingSupervisor = createSupervisor()
    const waiting = waitingSupervisor.subscribe('/waiting-root', vi.fn(), {})
    const waitingSettled = trackPromiseSettlement(waiting)
    await Promise.resolve()
    expect(waitingSettled()).toBe(false)

    children[0].connected = false
    children[0].emit('exit', null, 'SIGSEGV')
    await vi.waitFor(() =>
      expect(forkMock).toHaveBeenCalledTimes(MAX_PHYSICAL_WATCHER_CHILDREN + 1)
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(waitingSettled()).toBe(false)

    supervisors[1].dispose()
    children[1].emit('exit', 0, null)
    await vi.waitFor(() =>
      expect(forkMock).toHaveBeenCalledTimes(MAX_PHYSICAL_WATCHER_CHILDREN + 2)
    )
    const waitingChild = currentChild()
    expect(waitingChild.sent).toContainEqual(expect.objectContaining({ dir: '/waiting-root' }))
    acknowledgeWatcherSubscribe(waitingChild)
    await expect(waiting).resolves.toMatchObject({ unsubscribe: expect.any(Function) })
  })
})
