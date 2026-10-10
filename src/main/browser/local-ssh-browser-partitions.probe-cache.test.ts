import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  probe: vi.fn<() => Promise<'ok' | 'forwarding-blocked' | 'ssh-unavailable'>>()
}))

vi.mock('electron', () => {
  const sessions = new Map<string, object>()
  return {
    app: { on: vi.fn() },
    session: {
      fromPartition: (partition: string) => {
        let existing = sessions.get(partition)
        if (!existing) {
          existing = { partition }
          sessions.set(partition, existing)
        }
        return existing
      }
    },
    webContents: { getAllWebContents: () => [] }
  }
})
vi.mock('./browser-route-guest-guard', () => ({ closeRouteGuest: vi.fn() }))
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
  prepareBrowserRouteSessionPolicy: vi.fn(async () => {})
}))
vi.mock('./browser-route-webrtc-policy', () => ({ enforceBrowserRouteWebRtcPolicy: vi.fn() }))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    requireRouteBrowserProfile: vi.fn(),
    setupRoutePartitionPolicies: vi.fn(),
    clearRoutePartitionPolicies: vi.fn()
  }
}))
vi.mock('./local-ssh-browser-route', () => ({
  retainLocalSshBrowserRoute: vi.fn(async () => ({ host: '127.0.0.1', port: 1080 })),
  probeLocalSshBrowserRouteForwarding: mocks.probe,
  closeLocalSshBrowserRouteForTarget: vi.fn(async () => {})
}))

import { prepareLocalSshBrowserPartition } from './local-ssh-browser-partitions'

describe('prepareLocalSshBrowserPartition probe caching', () => {
  beforeEach(() => {
    mocks.probe.mockReset()
  })

  it('does not let a Try-anyway success satisfy a later probed prepare from cache', async () => {
    mocks.probe.mockResolvedValue('forwarding-blocked')

    const skipped = await prepareLocalSshBrowserPartition({
      targetId: 'target-undo',
      browserProfileId: 'default',
      skipProbe: true
    })
    expect(skipped.partition).toMatch(/^persist:orca-browser-v1-/)
    expect(mocks.probe).not.toHaveBeenCalled()

    // The user pressed "Check again": the next prepare must actually probe and
    // resurface the classified failure instead of returning the cached success.
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
