import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_PHYSICAL_WATCHER_CHILDREN,
  resetWatcherChildRegistryForTest
} from '../child-lifecycle/parcel-watcher-child-registry'
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

import { createWatcherProcessSupervisor } from '../parcel-watcher-process'

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
