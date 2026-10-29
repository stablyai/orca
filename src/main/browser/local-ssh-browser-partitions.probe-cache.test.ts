import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TestContents = {
  id: number
  session: object
  destroyed: boolean
  isDestroyed: () => boolean
}

const mocks = vi.hoisted(() => {
  const contents: TestContents[] = []
  return {
    contents,
    probe: vi.fn<() => Promise<'ok' | 'forwarding-blocked' | 'ssh-unavailable'>>(),
    census: vi.fn(() => [...contents]),
    closeGuest: vi.fn((contents: TestContents) => {
      contents.destroyed = true
    }),
    clearPolicies: vi.fn<(partition: string) => void>(),
    removeTarget: vi.fn(),
    clearStorage: vi.fn<(targetId: string) => Promise<void>>(),
    policy: vi.fn<() => Promise<void>>(),
    sessionForPartition: (_partition: string): object => ({}),
    emitCreated: (_contents: TestContents): void => {},
    listenerCount: (): number => 0
  }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const app = new EventEmitter()
  const sessions = new Map<string, object>()
  const fromPartition = (partition: string): object => {
    let existing = sessions.get(partition)
    if (!existing) {
      existing = { partition }
      sessions.set(partition, existing)
    }
    return existing
  }
  mocks.sessionForPartition = fromPartition
  mocks.emitCreated = (contents) => {
    app.emit('web-contents-created', {}, contents)
  }
  mocks.listenerCount = () => app.listenerCount('web-contents-created')
  return {
    app,
    session: { fromPartition },
    webContents: { getAllWebContents: mocks.census }
  }
})
vi.mock('./browser-route-guest-guard', () => ({ closeRouteGuest: mocks.closeGuest }))
vi.mock('./browser-route-partition-binding-runtime', () => {
  const fingerprints = new Map<string, string>()
  return {
    activeBrowserRoutePartitionOrcaProfileId: () => 'orca-profile-1',
    currentBrowserRoutePartitionBindingStore: () => ({
      get: (partition: string) => fingerprints.get(partition) ?? null,
      set: (partition: string, fingerprint: string) => {
        fingerprints.set(partition, fingerprint)
        return []
      },
      touch: vi.fn()
    })
  }
})
vi.mock('./browser-route-partition-retention', () => ({
  isBrowserRoutePartitionRetainedByAnyOwner: () => false,
  registerBrowserRoutePartitionRetentionProbe: vi.fn()
}))
vi.mock('./browser-route-partition-storage-dependencies', () => ({
  releaseEvictedBrowserRoutePartitionStorage: vi.fn(async () => {})
}))
vi.mock('./browser-route-session-policy', () => ({
  prepareBrowserRouteSessionPolicy: mocks.policy
}))
vi.mock('./browser-route-webrtc-policy', () => ({ enforceBrowserRouteWebRtcPolicy: vi.fn() }))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    requireRouteBrowserProfile: vi.fn(),
    setupRoutePartitionPolicies: vi.fn(),
    clearRoutePartitionPolicies: mocks.clearPolicies
  }
}))
vi.mock('./local-ssh-browser-route', () => ({
  retainLocalSshBrowserRoute: vi.fn(async () => ({ host: '127.0.0.1', port: 1080 })),
  probeLocalSshBrowserRouteForwarding: mocks.probe,
  closeLocalSshBrowserRouteForTarget: vi.fn(async () => {})
}))
vi.mock('../ssh/targets/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({ removeTarget: mocks.removeTarget })
}))
vi.mock('../ssh/ssh-host-server-status', () => ({ clearSshHostServerStatus: vi.fn() }))
vi.mock('../ssh/connection/ssh-connection-attribution', () => ({
  isSshConnectionSolelyOwnedBy: () => true
}))
vi.mock('../ipc/ssh/ssh-connect-attempt-registry', () => ({
  connectInFlight: new Map(),
  invalidateConnectAttempt: vi.fn(),
  isCurrentConnectAttempt: () => false
}))
vi.mock('../ipc/ssh/ssh-ipc-context', () => ({
  connectionManager: { disconnect: vi.fn(async () => {}) },
  persistedStore: { removeSshRemotePtyLeases: vi.fn() },
  portForwardManager: { removeAllForwards: vi.fn(async () => {}) }
}))
vi.mock('../ipc/ssh/ssh-managed-port-forward-restore', () => ({
  forgetPortForwardRestoreState: vi.fn()
}))
vi.mock('../ssh/legacy-relay/legacy-relay-bridge-registry', () => ({
  forgetLegacyRelayTarget: vi.fn(),
  stopLegacyRelayBridge: vi.fn()
}))
vi.mock('../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  closeOrcadManagedTunnelsForTarget: vi.fn(async () => {})
}))
vi.mock('./browser-route-partition-storage-runtime', () => ({
  clearBrowserRoutePartitionStorageForLocalSshTarget: mocks.clearStorage
}))

import {
  isLocalSshBrowserPartition,
  prepareLocalSshBrowserPartition,
  releaseLocalSshBrowserPartitionsForTarget
} from './local-ssh-browser-partitions'
import { removeRegisteredSshTarget } from '../ipc/ssh/ssh-session-teardown'
import { runTargetLifecycle, targetLifecycleInFlight } from '../ipc/ssh/ssh-target-lifecycle-queue'

beforeEach(() => {
  mocks.probe.mockReset().mockResolvedValue('ok')
  mocks.policy.mockReset().mockResolvedValue(undefined)
  mocks.contents.length = 0
  mocks.census.mockClear()
  mocks.clearPolicies.mockReset()
  mocks.removeTarget.mockReset()
  mocks.clearStorage.mockReset().mockResolvedValue(undefined)
  mocks.closeGuest.mockReset().mockImplementation((contents) => {
    contents.destroyed = true
  })
})
afterEach(() => vi.useRealTimers())

function createContents(partition: string): TestContents {
  const contents = {
    id: mocks.contents.length + 1,
    session: mocks.sessionForPartition(partition),
    destroyed: false,
    isDestroyed: () => contents.destroyed
  }
  mocks.contents.push(contents)
  mocks.emitCreated(contents)
  return contents
}

describe('prepareLocalSshBrowserPartition probe caching', () => {
  it('does not let a Try-anyway success satisfy a later probed prepare from cache', async () => {
    mocks.probe.mockResolvedValue('forwarding-blocked')

    const skipped = await prepareLocalSshBrowserPartition({
      targetId: 'target-undo',
      browserProfileId: 'default',
      skipProbe: true
    })
    expect(skipped.partition).toMatch(/^persist:orca-browser-v1-/)
    expect(mocks.probe).not.toHaveBeenCalled()

    await expect(
      prepareLocalSshBrowserPartition({ targetId: 'target-undo', browserProfileId: 'default' })
    ).rejects.toThrow('browser_local_route_forwarding_blocked')
    expect(mocks.probe).toHaveBeenCalledTimes(1)
  })

  it('still caches probed successes without re-probing', async () => {
    mocks.probe.mockResolvedValue('ok')

    const first = await prepareLocalSshBrowserPartition({
      targetId: 'target-cached',
      browserProfileId: 'default'
    })
    const second = await prepareLocalSshBrowserPartition({
      targetId: 'target-cached',
      browserProfileId: 'default'
    })
    expect(second.partition).toBe(first.partition)
    expect(mocks.probe).toHaveBeenCalledTimes(1)
  })

  it('mints the same partition for skipped and probed prepares of one target', async () => {
    mocks.probe.mockResolvedValue('ok')

    const skipped = await prepareLocalSshBrowserPartition({
      targetId: 'target-same',
      browserProfileId: 'default',
      skipProbe: true
    })
    const probed = await prepareLocalSshBrowserPartition({
      targetId: 'target-same',
      browserProfileId: 'default'
    })
    expect(probed.partition).toBe(skipped.partition)
  })
})

describe('releaseLocalSshBrowserPartitionsForTarget', () => {
  it.each([10, 100])(
    'enumerates contents once for %i prepared profiles and preserves other targets',
    async (profiles) => {
      const targetId = `census-${profiles}`
      const removed: TestContents[] = []
      for (let index = 0; index < profiles; index++) {
        const { partition } = await prepareLocalSshBrowserPartition({
          targetId,
          browserProfileId: `profile-${index}`
        })
        removed.push(createContents(partition))
      }
      const sibling = await prepareLocalSshBrowserPartition({
        targetId: `sibling-${profiles}`,
        browserProfileId: 'default'
      })
      const survivor = createContents(sibling.partition)
      for (let index = 0; index < 1_000; index++) {
        createContents('unrelated')
      }
      const listeners = mocks.listenerCount()
      mocks.clearPolicies.mockImplementation((partition) => {
        expect(
          removed
            .filter((contents) => contents.session === mocks.sessionForPartition(partition))
            .every((contents) => contents.destroyed)
        ).toBe(true)
      })

      await releaseLocalSshBrowserPartitionsForTarget(targetId)

      expect(mocks.census).toHaveBeenCalledTimes(1)
      expect(mocks.closeGuest).toHaveBeenCalledTimes(profiles)
      expect(removed.every((contents) => contents.destroyed)).toBe(true)
      expect(survivor.destroyed).toBe(false)
      expect(mocks.contents.slice(profiles + 1).every((contents) => !contents.destroyed)).toBe(true)
      expect(mocks.clearPolicies).toHaveBeenCalledTimes(profiles)
      expect(mocks.listenerCount()).toBe(listeners)
    }
  )

  it.each([false, true])(
    'waits for its own pending prepare (skipProbe=%s) and refreshes late guests',
    async (skipProbe) => {
      vi.useFakeTimers()
      const first = await prepareLocalSshBrowserPartition({
        targetId: `late-guest-${skipProbe}`,
        browserProfileId: 'first'
      })
      const firstContents = createContents(first.partition)
      const gate = Promise.withResolvers<void>()
      mocks.policy.mockImplementationOnce(() => gate.promise)
      const second = prepareLocalSshBrowserPartition({
        targetId: `late-guest-${skipProbe}`,
        browserProfileId: 'second',
        skipProbe
      })
      const firstClosed = Promise.withResolvers<void>()
      mocks.closeGuest.mockImplementationOnce((contents) => {
        contents.destroyed = true
        firstClosed.resolve()
      })
      const listeners = mocks.listenerCount()
      let released = false
      const releasing = releaseLocalSshBrowserPartitionsForTarget(`late-guest-${skipProbe}`).then(
        () => {
          released = true
        }
      )
      await firstClosed.promise
      await vi.advanceTimersByTimeAsync(0)
      expect(released).toBe(false)
      gate.resolve()
      const late = createContents((await second).partition)
      await releasing

      expect(firstContents.destroyed).toBe(true)
      expect(late.destroyed).toBe(true)
      expect(mocks.census).toHaveBeenCalledTimes(2)
      expect(mocks.listenerCount()).toBe(listeners)
    }
  )

  it.each([false, true])(
    'skips unrelated pending prepares (skipProbe=%s) across profiles and repeated release',
    async (skipProbe) => {
      vi.useFakeTimers()
      const gate = Promise.withResolvers<void>()
      mocks.policy.mockImplementationOnce(() => gate.promise)
      const siblingInput = {
        targetId: `held-sibling-${skipProbe}`,
        browserProfileId: 'default',
        skipProbe
      }
      const sibling = prepareLocalSshBrowserPartition(siblingInput)
      const targetId = `ready-owner-${skipProbe}`
      const first = await prepareLocalSshBrowserPartition({ targetId, browserProfileId: 'first' })
      expect(
        await prepareLocalSshBrowserPartition({
          targetId,
          browserProfileId: 'first',
          skipProbe: true
        })
      ).toEqual(first)
      const second = await prepareLocalSshBrowserPartition({
        targetId,
        browserProfileId: 'second',
        skipProbe
      })
      const removed = [createContents(first.partition), createContents(second.partition)]
      const listeners = mocks.listenerCount()
      let released = false
      const releasing = releaseLocalSshBrowserPartitionsForTarget(targetId).then(() => {
        released = true
      })
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(released).toBe(true)
        expect(removed.every((contents) => contents.destroyed)).toBe(true)
        expect(mocks.census).toHaveBeenCalledTimes(1)
        expect(mocks.clearPolicies).toHaveBeenCalledTimes(3)
        expect(mocks.listenerCount()).toBe(listeners)
      } finally {
        gate.resolve()
        await releasing
        await sibling
      }
      const survivor = createContents((await sibling).partition)
      const policyCalls = mocks.policy.mock.calls.length
      expect(await prepareLocalSshBrowserPartition(siblingInput)).toEqual(await sibling)
      expect(mocks.policy).toHaveBeenCalledTimes(policyCalls)
      await releaseLocalSshBrowserPartitionsForTarget(targetId)
      expect(mocks.census).toHaveBeenCalledTimes(1)
      expect(mocks.clearPolicies).toHaveBeenCalledTimes(3)
      expect(survivor.destroyed).toBe(false)
      expect(isLocalSshBrowserPartition((await sibling).partition)).toBe(true)
    }
  )

  it('deduplicates pending prepares and evicts a rejected own-target entry before retry', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<void>()
    mocks.policy.mockImplementationOnce(() => gate.promise)
    const input = { targetId: 'rejected-owner', browserProfileId: 'default' }
    const attempts = Promise.allSettled([
      prepareLocalSshBrowserPartition(input),
      prepareLocalSshBrowserPartition(input)
    ])
    let released = false
    const releasing = releaseLocalSshBrowserPartitionsForTarget(input.targetId).then(() => {
      released = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.policy).toHaveBeenCalledTimes(1)
    expect(released).toBe(false)
    const error = new Error('proxy setup failed')
    gate.reject(error)
    expect(await attempts).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error }
    ])
    await releasing
    expect(mocks.census).not.toHaveBeenCalled()
    const retried = await prepareLocalSshBrowserPartition(input)
    expect(mocks.policy).toHaveBeenCalledTimes(2)
    const contents = createContents(retried.partition)
    await releaseLocalSshBrowserPartitionsForTarget(input.targetId)
    expect(contents.destroyed).toBe(true)
    expect(isLocalSshBrowserPartition(retried.partition)).toBe(false)
  })

  it('finishes actual target removal and its lifecycle successor while another target prepares', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<void>()
    mocks.policy.mockImplementationOnce(() => gate.promise)
    const sibling = prepareLocalSshBrowserPartition({
      targetId: 'removal-sibling',
      browserProfileId: 'default'
    })
    const targetId = 'removed-owner'
    const target = await prepareLocalSshBrowserPartition({ targetId, browserProfileId: 'default' })
    const guest = createContents(target.partition)
    let removed = false
    let successorStarted = false
    const removing = removeRegisteredSshTarget(targetId).then(() => {
      removed = true
    })
    const successor = runTargetLifecycle(targetId, async () => {
      successorStarted = true
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.removeTarget).toHaveBeenCalledWith(targetId)
      expect(guest.destroyed).toBe(true)
      expect(isLocalSshBrowserPartition(target.partition)).toBe(false)
      expect(mocks.clearStorage.mock.calls).toEqual([[targetId]])
      expect(successorStarted).toBe(false)
      await vi.advanceTimersByTimeAsync(500)
      await removing
      await successor
      expect(removed).toBe(true)
      expect(successorStarted).toBe(true)
      expect(targetLifecycleInFlight.has(targetId)).toBe(false)
      expect(mocks.clearStorage.mock.calls).toEqual([[targetId], [targetId]])
    } finally {
      gate.resolve()
      await sibling
      await vi.advanceTimersByTimeAsync(500)
      await removing
      await successor
    }
    expect(isLocalSshBrowserPartition((await sibling).partition)).toBe(true)
  })

  it('skips destroyed guests and does no native census for an absent target', async () => {
    const { partition } = await prepareLocalSshBrowserPartition({
      targetId: 'destroyed-guest',
      browserProfileId: 'default'
    })
    const dead = createContents(partition)
    dead.destroyed = true
    const live = createContents(partition)
    await releaseLocalSshBrowserPartitionsForTarget('destroyed-guest')
    expect(mocks.closeGuest.mock.calls.map(([contents]) => contents)).toEqual([live])
    const calls = mocks.census.mock.calls.length
    await releaseLocalSshBrowserPartitionsForTarget('absent')
    expect(mocks.census).toHaveBeenCalledTimes(calls)
  })

  it('releases the creation listener if policy cleanup throws', async () => {
    const { partition } = await prepareLocalSshBrowserPartition({
      targetId: 'failed-cleanup',
      browserProfileId: 'default'
    })
    createContents(partition)
    const listeners = mocks.listenerCount()
    mocks.clearPolicies.mockImplementationOnce(() => {
      throw new Error('policy cleanup failed')
    })
    await expect(releaseLocalSshBrowserPartitionsForTarget('failed-cleanup')).rejects.toThrow(
      'policy cleanup failed'
    )
    expect(mocks.listenerCount()).toBe(listeners)
  })
})
