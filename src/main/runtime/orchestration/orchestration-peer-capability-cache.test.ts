import { describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { OrchestrationPeerCapabilityCache } from './orchestration-peer-capability-cache'

const capability = ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY

describe('OrchestrationPeerCapabilityCache', () => {
  it('coalesces concurrent probes and caches by peer and runtime epoch', async () => {
    const cache = new OrchestrationPeerCapabilityCache()
    let resolveStatus!: (value: ReturnType<typeof runtimeStatus>) => void
    const probe = vi.fn(
      () =>
        new Promise<ReturnType<typeof runtimeStatus>>((resolve) => {
          resolveStatus = resolve
        })
    )
    const args = {
      peerFingerprint: 'peer-a',
      expectedRuntimeEpoch: 'epoch-a',
      capability,
      probe
    }
    const first = cache.resolve(args)
    const second = cache.resolve(args)
    expect(probe).toHaveBeenCalledTimes(1)
    resolveStatus(runtimeStatus('epoch-a', true))
    await expect(Promise.all([first, second])).resolves.toEqual([
      { runtimeEpoch: 'epoch-a', supported: true, cached: false },
      { runtimeEpoch: 'epoch-a', supported: true, cached: false }
    ])
    await expect(cache.resolve(args)).resolves.toEqual({
      runtimeEpoch: 'epoch-a',
      supported: true,
      cached: true
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('re-probes after observing a new runtime epoch and isolates peers', async () => {
    const cache = new OrchestrationPeerCapabilityCache()
    const oldProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-a', false))
    await cache.resolve({
      peerFingerprint: 'peer-a',
      expectedRuntimeEpoch: 'epoch-a',
      capability,
      probe: oldProbe
    })
    cache.observeEpoch('peer-a', 'epoch-b')
    const newProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-b', true))
    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-a',
        capability,
        probe: newProbe
      })
    ).resolves.toMatchObject({ runtimeEpoch: 'epoch-b', supported: true, cached: false })
    const peerBProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-a', false))
    await cache.resolve({
      peerFingerprint: 'peer-b',
      expectedRuntimeEpoch: 'epoch-a',
      capability,
      probe: peerBProbe
    })
    expect(newProbe).toHaveBeenCalledTimes(1)
    expect(peerBProbe).toHaveBeenCalledTimes(1)
  })

  it('re-probes an expired negative after restart without an external epoch observation', async () => {
    let now = 1_000
    const cache = new OrchestrationPeerCapabilityCache({
      negativeTtlMs: 500,
      now: () => now
    })
    const oldProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-a', false))
    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-a',
        capability,
        probe: oldProbe
      })
    ).resolves.toMatchObject({ runtimeEpoch: 'epoch-a', supported: false, cached: false })

    const prematureProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-b', true))
    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-a',
        capability,
        probe: prematureProbe
      })
    ).resolves.toEqual({ runtimeEpoch: 'epoch-a', supported: false, cached: true })
    expect(prematureProbe).not.toHaveBeenCalled()

    now += 501
    const restartedProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-b', true))
    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-a',
        capability,
        probe: restartedProbe
      })
    ).resolves.toEqual({ runtimeEpoch: 'epoch-b', supported: true, cached: false })

    const redundantProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-b', true))
    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-a',
        capability,
        probe: redundantProbe
      })
    ).resolves.toEqual({ runtimeEpoch: 'epoch-b', supported: true, cached: true })
    expect(oldProbe).toHaveBeenCalledOnce()
    expect(restartedProbe).toHaveBeenCalledOnce()
    expect(redundantProbe).not.toHaveBeenCalled()
  })

  it('does not let a late old-epoch probe evict a newer epoch', async () => {
    const cache = new OrchestrationPeerCapabilityCache()
    let resolveOld!: (value: ReturnType<typeof runtimeStatus>) => void
    const oldProbe = vi.fn(
      () =>
        new Promise<ReturnType<typeof runtimeStatus>>((resolve) => {
          resolveOld = resolve
        })
    )
    const oldDecision = cache.resolve({
      peerFingerprint: 'peer-a',
      expectedRuntimeEpoch: 'epoch-a',
      capability,
      probe: oldProbe
    })

    cache.observeEpoch('peer-a', 'epoch-b')
    const newProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-b', true))
    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-b',
        capability,
        probe: newProbe
      })
    ).resolves.toEqual({ runtimeEpoch: 'epoch-b', supported: true, cached: false })

    resolveOld(runtimeStatus('epoch-a', false))
    await expect(oldDecision).resolves.toEqual({
      runtimeEpoch: 'epoch-b',
      supported: true,
      cached: true
    })
    const afterRestartProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-b', true))
    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-b',
        capability,
        probe: afterRestartProbe
      })
    ).resolves.toMatchObject({ runtimeEpoch: 'epoch-b', supported: true, cached: true })
    expect(afterRestartProbe).not.toHaveBeenCalled()
  })

  it('does not let a stale expected epoch replace an already observed epoch', async () => {
    const cache = new OrchestrationPeerCapabilityCache()
    cache.remember('peer-a', 'epoch-b', capability, true)
    const staleProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-a', false))

    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-a',
        capability,
        probe: staleProbe
      })
    ).resolves.toEqual({ runtimeEpoch: 'epoch-b', supported: true, cached: true })

    expect(staleProbe).not.toHaveBeenCalled()
    const currentProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-b', true))
    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-b',
        capability,
        probe: currentProbe
      })
    ).resolves.toEqual({ runtimeEpoch: 'epoch-b', supported: true, cached: true })
    expect(currentProbe).not.toHaveBeenCalled()
  })

  it('does not cache failed probes', async () => {
    const cache = new OrchestrationPeerCapabilityCache()
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay lost'))
      .mockResolvedValueOnce(runtimeStatus('epoch-a', true))
    const args = {
      peerFingerprint: 'peer-a',
      expectedRuntimeEpoch: 'epoch-a',
      capability,
      probe
    }
    await expect(cache.resolve(args)).rejects.toThrow('relay lost')
    await expect(cache.resolve(args)).resolves.toMatchObject({ supported: true, cached: false })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('answers other capability checks from the same epoch status response', async () => {
    const cache = new OrchestrationPeerCapabilityCache()
    const probe = vi.fn().mockResolvedValue(runtimeStatus('epoch-a', true))
    await cache.resolve({
      peerFingerprint: 'peer-a',
      expectedRuntimeEpoch: 'epoch-a',
      capability,
      probe
    })
    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-a',
        capability: ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
        probe
      })
    ).resolves.toMatchObject({ supported: false, cached: true })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('bounds peer state and re-probes an evicted peer', async () => {
    const cache = new OrchestrationPeerCapabilityCache({ maxPeers: 2 })
    cache.remember('peer-a', 'epoch-a', capability, true)
    cache.remember('peer-b', 'epoch-b', capability, true)
    cache.remember('peer-c', 'epoch-c', capability, true)
    const probe = vi.fn().mockResolvedValue(runtimeStatus('epoch-a', true))

    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-a',
        capability,
        probe
      })
    ).resolves.toEqual({ runtimeEpoch: 'epoch-a', supported: true, cached: false })

    expect(probe).toHaveBeenCalledOnce()
  })

  it('rejects a late pre-eviction probe and finalizer after the peer is re-added', async () => {
    const cache = new OrchestrationPeerCapabilityCache({ maxPeers: 1 })
    let resolveOld!: (value: ReturnType<typeof runtimeStatus>) => void
    const oldProbe = vi.fn(
      () =>
        new Promise<ReturnType<typeof runtimeStatus>>((resolve) => {
          resolveOld = resolve
        })
    )
    const oldDecision = cache.resolve({
      peerFingerprint: 'peer-a',
      expectedRuntimeEpoch: 'epoch-a',
      capability,
      probe: oldProbe
    })
    cache.remember('peer-b', 'epoch-b', capability, true)

    let resolveNew!: (value: ReturnType<typeof runtimeStatus>) => void
    const newProbe = vi.fn(
      () =>
        new Promise<ReturnType<typeof runtimeStatus>>((resolve) => {
          resolveNew = resolve
        })
    )
    const newDecision = cache.resolve({
      peerFingerprint: 'peer-a',
      expectedRuntimeEpoch: 'epoch-a',
      capability,
      probe: newProbe
    })
    resolveOld(runtimeStatus('epoch-a', false))
    await new Promise<void>((resolve) => setImmediate(resolve))
    resolveNew(runtimeStatus('epoch-c', true))

    await expect(Promise.all([oldDecision, newDecision])).resolves.toEqual([
      { runtimeEpoch: 'epoch-c', supported: true, cached: false },
      { runtimeEpoch: 'epoch-c', supported: true, cached: false }
    ])
    const redundantProbe = vi.fn().mockResolvedValue(runtimeStatus('epoch-c', true))
    await expect(
      cache.resolve({
        peerFingerprint: 'peer-a',
        expectedRuntimeEpoch: 'epoch-c',
        capability,
        probe: redundantProbe
      })
    ).resolves.toEqual({ runtimeEpoch: 'epoch-c', supported: true, cached: true })
    expect(oldProbe).toHaveBeenCalledOnce()
    expect(newProbe).toHaveBeenCalledOnce()
    expect(redundantProbe).not.toHaveBeenCalled()
  })

  it('ignores a remember() for an epoch the peer already moved off', async () => {
    const cache = new OrchestrationPeerCapabilityCache()
    let releaseProbe!: (value: ReturnType<typeof runtimeStatus>) => void
    const inFlight = cache.resolve({
      peerFingerprint: 'peer-a',
      expectedRuntimeEpoch: 'epoch-a',
      capability,
      probe: () =>
        new Promise<ReturnType<typeof runtimeStatus>>((resolve) => {
          releaseProbe = resolve
        })
    })

    cache.observeEpoch('peer-a', 'epoch-b')
    cache.remember('peer-a', 'epoch-b', capability, true)
    expect(cache.knownSupport('peer-a', null, capability)).toEqual({
      runtimeEpoch: 'epoch-b',
      supported: true,
      cached: true
    })

    // The retired epoch-a answer lands last; it used to mint the highest sequence and win.
    cache.remember('peer-a', 'epoch-a', capability, false)
    releaseProbe(runtimeStatus('epoch-a', false))
    await inFlight.catch(() => undefined)

    expect(cache.knownSupport('peer-a', null, capability)).toEqual({
      runtimeEpoch: 'epoch-b',
      supported: true,
      cached: true
    })
  })

  it('still records the first remember() for a peer it has never observed', () => {
    const cache = new OrchestrationPeerCapabilityCache()

    cache.remember('peer-a', 'epoch-a', capability, true)

    expect(cache.knownSupport('peer-a', null, capability)).toEqual({
      runtimeEpoch: 'epoch-a',
      supported: true,
      cached: true
    })
  })

  it('accepts a response that advances the epoch it was sent against', () => {
    const cache = new OrchestrationPeerCapabilityCache()
    cache.remember('peer-a', 'epoch-a', capability, true)

    cache.remember('peer-a', 'epoch-b', capability, false, 'epoch-a')

    expect(cache.knownSupport('peer-a', null, capability)).toEqual({
      runtimeEpoch: 'epoch-b',
      supported: false,
      cached: true
    })
  })
})

function runtimeStatus(runtimeId: string, supported: boolean) {
  return {
    runtimeId,
    capabilities: supported ? [capability] : [],
    rendererGraphEpoch: 0,
    graphStatus: 'ready' as const,
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}
