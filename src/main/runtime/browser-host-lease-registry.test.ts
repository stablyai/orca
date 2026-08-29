import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'

const registry = (reconnectGraceMs?: number): BrowserHostLeaseRegistry =>
  new BrowserHostLeaseRegistry({
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    reconnectGraceMs
  })

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserHostLeaseRegistry', () => {
  it('requires reconciliation dependencies before retaining the negotiated lease', () => {
    const leases = registry()
    const attach = (overrides: Record<string, unknown>) =>
      leases.attach({
        browserHostClientId: 'host-a',
        connectionId: 'connection-a',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview'],
        pageReconciliationProtocolVersion: 1,
        ...overrides
      })

    expect(() => attach({})).toThrow('browser_host_reconciliation_protocol_dependencies_required')
    expect(() => attach({ pageCommandProtocolVersion: 1 })).toThrow(
      'browser_host_reconciliation_protocol_dependencies_required'
    )
    expect(
      attach({
        pageCommandProtocolVersion: 1,
        pageInventoryProtocolVersion: 1,
        pageInventory: []
      }).lease
    ).toMatchObject({ pageReconciliationProtocolVersion: 1 })
  })

  it('rejects incomplete, duplicate, and foreign-client inventory before replacing a lease', () => {
    const leases = registry()
    const attach = (overrides: Record<string, unknown>) =>
      leases.attach({
        browserHostClientId: 'host-a',
        connectionId: 'connection-a',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview'],
        ...overrides
      })
    const page = inventoryPage()

    expect(() => attach({ pageInventoryProtocolVersion: 1 })).toThrow(
      'browser_host_page_inventory_negotiation_incomplete'
    )
    expect(() =>
      attach({ pageInventoryProtocolVersion: 2 as never, pageInventory: [page] })
    ).toThrow('browser_host_page_inventory_protocol_unsupported')
    expect(() => attach({ pageInventory: [page] })).toThrow(
      'browser_host_page_inventory_negotiation_incomplete'
    )
    expect(() => attach({ pageInventoryProtocolVersion: 1, pageInventory: [page, page] })).toThrow(
      'Duplicate browser page inventory identity'
    )
    expect(() =>
      attach({
        pageInventoryProtocolVersion: 1,
        pageInventory: [{ ...page, browserHostClientId: 'host-b' }]
      })
    ).toThrow('browser_host_page_inventory_authority_mismatch')
    expect(
      attach({
        pageInventoryProtocolVersion: 1,
        pageInventory: [{ ...page, authorityRuntimeId: 'runtime-old' }]
      }).lease.pageInventory
    ).toEqual([expect.objectContaining({ authorityRuntimeId: 'runtime-old' })])
  })

  it('retains an immutable inventory snapshot on the authenticated lease', () => {
    const leases = registry()
    const page = inventoryPage()
    const pageInventory = [page]
    const lease = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageInventoryProtocolVersion: 1,
      pageInventory
    }).lease

    page.currentUrl = 'https://mutated.invalid/'
    pageInventory.length = 0

    expect(lease.pageInventory).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', currentUrl: 'https://remote.internal/' })
    ])
    expect(Object.isFrozen(lease.pageInventory)).toBe(true)
    expect(Object.isFrozen(lease.pageInventory?.[0])).toBe(true)
  })

  it('keeps a negotiated lease unavailable during grace and restores its exact authority', async () => {
    vi.useFakeTimers()
    const leases = registry(1_000)
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageInventoryProtocolVersion: 1,
      pageInventory: [inventoryPage()],
      leaseReconnectProtocolVersion: 1
    })
    const placement = leases.placeClientPage('page-a', 'host-a')
    const route = leases.openTunnel({
      authorityEpoch: first.lease.authorityEpoch,
      browserHostClientId: first.lease.browserHostClientId,
      browserHostGeneration: first.lease.browserHostGeneration,
      pairedDeviceId: first.lease.pairedDeviceId,
      executionHostKey: 'native:runtime-a:1'
    })

    first.disconnect()

    expect(() => leases.select('host-a')).toThrow('browser_host_unavailable')
    expect(leases.getPlacement('page-a')).toEqual(placement)
    await expect(route.whenFenced).resolves.toBe('lease_released')
    let fenced = false
    void first.whenFenced.then(() => {
      fenced = true
    })
    await Promise.resolve()
    expect(fenced).toBe(false)

    const replacementInventory = [{ ...inventoryPage(), currentUrl: 'https://reconnected/' }]
    const replacement = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageInventoryProtocolVersion: 1,
      pageInventory: replacementInventory,
      leaseReconnectProtocolVersion: 1
    })

    expect(replacement.lease).toMatchObject({
      authorityEpoch: first.lease.authorityEpoch,
      browserHostGeneration: first.lease.browserHostGeneration,
      connectionId: 'connection-b',
      pageInventory: replacementInventory
    })
    expect(leases.select('host-a')).toEqual(replacement.lease)
    first.disconnect()
    expect(leases.select('host-a')).toEqual(replacement.lease)
  })

  it('replaces instead of restoring a lease when reconciliation negotiation changes', async () => {
    const leases = registry()
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      pageReconciliationProtocolVersion: 1,
      leaseReconnectProtocolVersion: 1
    })
    first.disconnect()

    const replacement = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      leaseReconnectProtocolVersion: 1
    })

    expect(replacement.lease.browserHostGeneration).toBe(first.lease.browserHostGeneration + 1)
    expect(replacement.lease).not.toHaveProperty('pageReconciliationProtocolVersion')
    await expect(first.whenFenced).resolves.toBe('replaced')
  })

  it('never emits reconciliation commands to a legacy page-command lease', () => {
    const leases = registry()
    const host = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1
    })
    const identity = {
      authorityEpoch: host.lease.authorityEpoch,
      browserHostClientId: host.lease.browserHostClientId,
      browserHostGeneration: host.lease.browserHostGeneration,
      pairedDeviceId: host.lease.pairedDeviceId
    }
    const delivery = vi.fn()
    leases.attachCommandDelivery(identity, delivery)
    const placement = leases.placeClientPage('page-a', 'host-a')
    if (placement.kind !== 'client') {
      throw new Error('expected client placement')
    }
    const authority = {
      authorityRuntimeId: host.lease.authorityRuntimeId,
      authorityEpoch: host.lease.authorityEpoch,
      browserPageId: 'page-a',
      browserHostClientId: host.lease.browserHostClientId,
      browserHostGeneration: host.lease.browserHostGeneration,
      pageHostGeneration: placement.pageHostGeneration
    }

    expect(() =>
      leases.issueClientPageCommand(authority, {
        type: 'restorePage',
        browserProfileId: 'default',
        executionHostKey: 'host-key-a'
      })
    ).toThrow('browser_host_reconciliation_protocol_required')
    expect(delivery).not.toHaveBeenCalled()

    leases.grantExecutionHost(identity, 'host-key-a')
    const legacy = leases.issueClientPageCommand(authority, {
      type: 'createPage',
      browserProfileId: 'default',
      executionHostKey: 'host-key-a'
    })
    expect(legacy.event).not.toHaveProperty('pageReconciliationProtocolVersion')
    expect(delivery).toHaveBeenCalledWith(legacy.event)
  })

  it('restores exact authority when reattach arrives before old connection cleanup', async () => {
    const leases = registry()
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      leaseReconnectProtocolVersion: 1
    })
    const placement = leases.placeClientPage('page-a', 'host-a')
    const route = leases.openTunnel({
      authorityEpoch: first.lease.authorityEpoch,
      browserHostClientId: first.lease.browserHostClientId,
      browserHostGeneration: first.lease.browserHostGeneration,
      pairedDeviceId: first.lease.pairedDeviceId,
      executionHostKey: 'native:runtime-a:1'
    })
    const releaseOldDelivery = leases.attachCommandDelivery(
      {
        authorityEpoch: first.lease.authorityEpoch,
        browserHostClientId: first.lease.browserHostClientId,
        browserHostGeneration: first.lease.browserHostGeneration,
        pairedDeviceId: first.lease.pairedDeviceId
      },
      vi.fn()
    )

    const replacement = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      leaseReconnectProtocolVersion: 1
    })

    await expect(first.whenConnectionSuperseded).resolves.toBeUndefined()
    await expect(route.whenFenced).resolves.toBe('lease_released')
    expect(replacement.lease.browserHostGeneration).toBe(first.lease.browserHostGeneration)
    expect(leases.getPlacement('page-a')).toEqual(placement)
    expect(() =>
      leases.attachCommandDelivery(
        {
          authorityEpoch: replacement.lease.authorityEpoch,
          browserHostClientId: replacement.lease.browserHostClientId,
          browserHostGeneration: replacement.lease.browserHostGeneration,
          pairedDeviceId: replacement.lease.pairedDeviceId
        },
        vi.fn()
      )
    ).not.toThrow()
    releaseOldDelivery()
    first.disconnect()
    expect(leases.select('host-a')).toEqual(replacement.lease)
  })

  it('expires negotiated grace and keeps legacy disconnect behavior immediate', async () => {
    vi.useFakeTimers()
    const leases = registry(1_000)
    const reconnecting = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      leaseReconnectProtocolVersion: 1
    })
    reconnecting.disconnect()

    await vi.advanceTimersByTimeAsync(999)
    let fenced = false
    void reconnecting.whenFenced.then(() => {
      fenced = true
    })
    await Promise.resolve()
    expect(fenced).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(reconnecting.whenFenced).resolves.toBe('released')

    const legacy = leases.attach({
      browserHostClientId: 'host-b',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-b',
      hostCapabilities: ['webview']
    })
    legacy.disconnect()
    await expect(legacy.whenFenced).resolves.toBe('released')
  })

  it('keeps foreign devices out and makes explicit grace revocation terminal', async () => {
    const leases = registry()
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      leaseReconnectProtocolVersion: 1
    })
    first.disconnect()

    expect(() =>
      leases.attach({
        browserHostClientId: 'host-a',
        connectionId: 'foreign-connection',
        pairedDeviceId: 'device-b',
        hostCapabilities: ['webview'],
        pageInventoryProtocolVersion: 1,
        pageInventory: [],
        leaseReconnectProtocolVersion: 1
      })
    ).toThrow('browser_host_identity_conflict')
    first.release()
    await expect(first.whenFenced).resolves.toBe('released')

    const late = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      leaseReconnectProtocolVersion: 1
    })
    expect(late.lease.browserHostGeneration).toBe(first.lease.browserHostGeneration + 1)
  })

  it('restores a lease whose reconnect renegotiates the file channel', async () => {
    const leases = registry()
    const attach = (connectionId: string, fileChannel: boolean) =>
      leases.attach({
        browserHostClientId: 'host-a',
        connectionId,
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview'],
        pageCommandProtocolVersion: 1,
        pageInventoryProtocolVersion: 1,
        pageInventory: [],
        leaseReconnectProtocolVersion: 1,
        ...(fileChannel ? { fileChannelProtocolVersion: 1 as const } : {})
      })
    const first = attach('connection-a', true)
    expect(first.lease.fileChannelProtocolVersion).toBe(1)
    first.disconnect()

    const downgraded = attach('connection-b', false)
    expect(downgraded.lease.browserHostGeneration).toBe(first.lease.browserHostGeneration)
    expect(downgraded.lease.fileChannelProtocolVersion).toBeUndefined()
    downgraded.disconnect()

    const restored = attach('connection-c', true)
    expect(restored.lease.browserHostGeneration).toBe(first.lease.browserHostGeneration)
    expect(restored.lease.fileChannelProtocolVersion).toBe(1)
  })

  it('replaces reconnecting authority on a capability mismatch', async () => {
    const leases = registry()
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      leaseReconnectProtocolVersion: 1
    })
    first.disconnect()

    const mismatch = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview', 'different'],
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      leaseReconnectProtocolVersion: 1
    })

    await expect(first.whenFenced).resolves.toBe('replaced')
    expect(mismatch.lease.browserHostGeneration).toBe(first.lease.browserHostGeneration + 1)
  })

  it('selects only an exact host when more than one lease is live', () => {
    const leases = registry()
    leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    leases.attach({
      browserHostClientId: 'host-b',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-b',
      hostCapabilities: ['webview']
    })

    expect(() => leases.select()).toThrow('browser_host_ambiguous')
    expect(leases.select('host-a')).toMatchObject({
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1
    })
    expect(() => leases.select('missing')).toThrow('browser_host_unavailable')
  })

  it('fences a same-device replacement without letting old cleanup remove it', async () => {
    const leases = registry()
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    const replacement = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })

    await expect(first.whenFenced).resolves.toBe('replaced')
    expect(replacement.lease.browserHostGeneration).toBe(2)
    first.release()
    expect(leases.select('host-a')).toEqual(replacement.lease)
    expect(() =>
      leases.attach({
        browserHostClientId: 'host-a',
        connectionId: 'connection-c',
        pairedDeviceId: 'device-b',
        hostCapabilities: ['webview']
      })
    ).toThrow('browser_host_identity_conflict')
  })

  it('admits only one distinct browser host per authenticated connection', () => {
    const leases = registry()
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })

    expect(() =>
      leases.attach({
        browserHostClientId: 'host-b',
        connectionId: 'connection-a',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      })
    ).toThrow('browser_host_connection_capacity')
    first.release()
    expect(
      leases.attach({
        browserHostClientId: 'host-b',
        connectionId: 'connection-a',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      }).lease.browserHostClientId
    ).toBe('host-b')
  })

  it('bounds distinct browser hosts per paired device without starving another device', () => {
    const leases = registry()
    const handles = Array.from({ length: 4 }, (_, index) =>
      leases.attach({
        browserHostClientId: `host-${index}`,
        connectionId: `connection-${index}`,
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      })
    )

    expect(() =>
      leases.attach({
        browserHostClientId: 'host-overflow',
        connectionId: 'connection-overflow',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      })
    ).toThrow('browser_host_device_capacity')
    expect(
      leases.attach({
        browserHostClientId: 'host-other-device',
        connectionId: 'connection-other-device',
        pairedDeviceId: 'device-b',
        hostCapabilities: ['webview']
      }).lease.browserHostClientId
    ).toBe('host-other-device')
    handles[0]!.release()
    expect(
      leases.attach({
        browserHostClientId: 'host-after-release',
        connectionId: 'connection-after-release',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      }).lease.browserHostClientId
    ).toBe('host-after-release')
  })

  it('allocates monotonic page generations and rejects a stale host generation', () => {
    const leases = registry()
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })

    const server = leases.placeServerPage('page-a')
    expect(server).toEqual({ kind: 'server' })
    const serverRetirement = leases.beginPageRetirement('page-a', server)
    expect(leases.completePageRetirement(serverRetirement)).toBe(true)
    const client = leases.placeClientPage('page-a', 'host-a')
    expect(client).toEqual({
      kind: 'client',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1,
      pageHostGeneration: 1
    })
    first.release()
    leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })

    expect(() =>
      leases.requireLease({
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'host-a',
        browserHostGeneration: 1,
        pairedDeviceId: 'device-a'
      })
    ).toThrow('browser_host_lease_stale')
    expect(leases.getPlacement('page-a')).toBeUndefined()
    expect(leases.placeClientPage('page-a', 'host-a')).toMatchObject({
      browserHostGeneration: 2,
      pageHostGeneration: 2
    })
  })

  it('retires closed page placement without reusing its generation', () => {
    const leases = registry()
    leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    const first = leases.placeClientPage('page-a', 'host-a')

    const retirement = leases.beginPageRetirement('page-a', first)
    expect(leases.completePageRetirement(retirement)).toBe(true)

    expect(leases.getPlacement('page-a')).toBeUndefined()
    expect(leases.placeClientPage('page-a', 'host-a')).toMatchObject({
      pageHostGeneration: first.kind === 'client' ? first.pageHostGeneration + 1 : Number.NaN
    })
  })

  it('fences outstanding outcomes at exact placement retirement', async () => {
    const leases = registry()
    const host = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1
    })
    const identity = {
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1,
      pairedDeviceId: 'device-a'
    }
    leases.attachCommandDelivery(identity, () => {})
    leases.grantExecutionHost(identity, 'host-key-a')
    const placement = leases.placeClientPage('page-a', 'host-a')
    if (placement.kind !== 'client') {
      throw new Error('expected client placement')
    }
    const authority = {
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a',
      browserPageId: 'page-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1,
      pageHostGeneration: placement.pageHostGeneration
    }
    const issued = leases.issueClientPageCommand(authority, {
      type: 'createPage',
      browserProfileId: 'default',
      executionHostKey: 'host-key-a'
    })
    const firstRetirement = leases.beginPageRetirement('page-a', placement)

    expect(leases.completePageRetirement(firstRetirement)).toBe(true)
    expect(leases.getPlacement('page-a')).toBeUndefined()
    await expect(issued.result).rejects.toThrow('browser_host_command_outcome_unknown')
    host.release()
  })

  it('does not let late cleanup retire a replacement or server placement', () => {
    const leases = registry()
    leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    const first = leases.placeClientPage('page-a', 'host-a')
    const firstRetirement = leases.beginPageRetirement('page-a', first)
    expect(leases.completePageRetirement(firstRetirement)).toBe(true)
    const replacement = leases.placeClientPage('page-a', 'host-a')

    expect(leases.completePageRetirement(firstRetirement)).toBe(false)
    expect(leases.getPlacement('page-a')).toBe(replacement)
    const replacementRetirement = leases.beginPageRetirement('page-a', replacement)
    expect(leases.completePageRetirement(replacementRetirement)).toBe(true)
    const server = leases.placeServerPage('page-a')
    expect(leases.completePageRetirement(replacementRetirement)).toBe(false)
    expect(leases.getPlacement('page-a')).toBe(server)
    const serverRetirement = leases.beginPageRetirement('page-a', server)
    expect(leases.completePageRetirement(serverRetirement)).toBe(true)
  })

  it('binds tunnel generations to the lease and fences replaced routes', async () => {
    const leases = registry()
    const host = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    const identity = {
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1,
      pairedDeviceId: 'device-a',
      executionHostKey: 'native:runtime-a'
    }
    const firstRoute = leases.openTunnel(identity)
    const replacementRoute = leases.openTunnel(identity)

    expect(firstRoute.tunnelGeneration).toBe(1)
    expect(replacementRoute.tunnelGeneration).toBe(2)
    await expect(firstRoute.whenFenced).resolves.toBe('replaced')
    host.release()
    await expect(replacementRoute.whenFenced).resolves.toBe('lease_released')
    expect(() => leases.openTunnel(identity)).toThrow('browser_host_lease_required')
  })

  it('grants one exact execution host without letting old cleanup remove a replacement', async () => {
    const leases = registry()
    const host = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    const identity = {
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1,
      pairedDeviceId: 'device-a'
    }
    const first = leases.grantExecutionHost(identity, 'ssh:target-a')
    const replacement = leases.grantExecutionHost(identity, 'ssh:target-a')
    const route = leases.openTunnel(
      { ...identity, executionHostKey: 'ssh:target-a' },
      { requireExecutionHostGrant: true }
    )

    first.release()
    expect(() => leases.requireExecutionHost(identity, 'ssh:target-a')).not.toThrow()
    expect(() => leases.requireExecutionHost(identity, 'ssh:target-b')).toThrow(
      'browser_tunnel_execution_host_not_granted'
    )
    replacement.release()
    await expect(route.whenFenced).resolves.toBe('released')
    expect(() => leases.requireExecutionHost(identity, 'ssh:target-a')).toThrow(
      'browser_tunnel_execution_host_not_granted'
    )
    host.release()
  })

  it('invalidates execution-host grants with their exact lease generation', () => {
    const leases = registry()
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    const firstIdentity = {
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1,
      pairedDeviceId: 'device-a'
    }
    const oldGrant = leases.grantExecutionHost(firstIdentity, 'ssh:target-a')

    leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })

    expect(() => leases.requireExecutionHost(firstIdentity, 'ssh:target-a')).toThrow(
      'browser_host_lease_stale'
    )
    oldGrant.release()
    first.release()
    expect(() =>
      leases.requireExecutionHost({ ...firstIdentity, browserHostGeneration: 2 }, 'ssh:target-a')
    ).toThrow('browser_tunnel_execution_host_not_granted')
  })
})

function inventoryPage() {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-old',
    browserHostClientId: 'host-a',
    browserHostGeneration: 2,
    browserPageId: 'page-a',
    pageHostGeneration: 3,
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    state: 'active' as const,
    currentUrl: 'https://remote.internal/'
  }
}
