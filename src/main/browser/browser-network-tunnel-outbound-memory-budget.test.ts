import { describe, expect, it } from 'vitest'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from './browser-network-tunnel-outbound-memory-budget'

describe('BrowserNetworkTunnelOutboundMemoryBudgetRegistry', () => {
  it('shares one host ceiling across application, encrypted queue, and native buffers', () => {
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({
      hostMaxBytes: 10,
      processMaxBytes: 100
    })
    const first = registry.acquire('host-a')!
    const second = registry.acquire('host-a')!
    const releaseApplication = first.claimApplicationBytes(4)
    const releaseQueued = second.claimQueuedBytes(3)
    let buffered = 2
    const socket = second.registerBufferedAmount(() => buffered)!

    expect(releaseApplication).not.toBeNull()
    expect(releaseQueued).not.toBeNull()
    expect(socket.canSend(1)).toBe(true)
    expect(socket.canSend(2)).toBe(false)
    buffered = 3
    expect(first.claimApplicationBytes(1)).toBeNull()

    releaseQueued?.()
    expect(first.claimApplicationBytes(1)).not.toBeNull()
  })

  it('shares one process ceiling across distinct browser hosts and restores exact admission', () => {
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({
      hostMaxBytes: 100,
      processMaxBytes: 10
    })
    const first = registry.acquire('host-a')!
    const second = registry.acquire('host-b')!
    const releaseFirst = first.claimApplicationBytes(6)
    const releaseSecond = second.claimQueuedBytes(4)

    expect(releaseFirst).not.toBeNull()
    expect(releaseSecond).not.toBeNull()
    expect(second.claimApplicationBytes(1)).toBeNull()

    releaseFirst?.()
    expect(second.claimApplicationBytes(1)).not.toBeNull()
  })

  it('bounds claims and socket sources independently of byte size', () => {
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({
      hostMaxBytes: 100,
      processMaxBytes: 100,
      hostMaxClaims: 2,
      processMaxClaims: 3,
      hostMaxSocketSources: 1,
      processMaxSocketSources: 2
    })
    const first = registry.acquire('host-a')!
    const second = registry.acquire('host-b')!
    const releaseFirst = first.claimApplicationBytes(0)
    const releaseSecond = first.claimQueuedBytes(0)

    expect(releaseFirst).not.toBeNull()
    expect(releaseSecond).not.toBeNull()
    expect(first.claimQueuedBytes(0)).toBeNull()
    expect(second.claimQueuedBytes(0)).not.toBeNull()
    expect(second.claimQueuedBytes(0)).toBeNull()

    const socket = first.registerBufferedAmount(() => 0)
    expect(socket).not.toBeNull()
    expect(first.registerBufferedAmount(() => 0)).toBeNull()
    socket?.release()
    expect(first.registerBufferedAmount(() => 0)).not.toBeNull()
  })

  it('fences released leases and retains accounting until every exact owner releases', () => {
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({ processMaxHosts: 1 })
    const lease = registry.acquire('host-a')!
    const releaseClaim = lease.claimApplicationBytes(3)
    const socket = lease.registerBufferedAmount(() => 2)!

    expect(registry.acquire('host-b')).toBeNull()
    lease.release()
    expect(lease.claimApplicationBytes(1)).toBeNull()
    expect(lease.registerBufferedAmount(() => 0)).toBeNull()
    expect(socket.canSend(1)).toBe(false)
    expect(registry.evidence()).toMatchObject({ hosts: 1, leases: 0, retainedBytes: 3 })

    releaseClaim?.()
    socket.release()
    expect(registry.evidence()).toMatchObject({
      hosts: 0,
      leases: 0,
      retainedBytes: 0,
      bufferedBytes: 0,
      claims: 0,
      socketSources: 0
    })
    expect(registry.acquire('host-b')).not.toBeNull()
  })

  it('treats unavailable native-buffer evidence as full until the source releases', () => {
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({
      hostMaxBytes: 10,
      processMaxBytes: 10
    })
    const lease = registry.acquire('host-a')!
    const socket = lease.registerBufferedAmount(() => {
      throw new Error('socket unavailable')
    })!

    expect(socket.canSend(1)).toBe(false)
    expect(lease.claimApplicationBytes(1)).toBeNull()
    socket.release()
    expect(lease.claimApplicationBytes(1)).not.toBeNull()
  })
})
