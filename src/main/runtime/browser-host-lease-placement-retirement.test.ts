import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type {
  BrowserClientPageAuthority,
  RuntimeBrowserClientPlacement
} from './browser-host-page-placement'

const registry = (reconnectGraceMs?: number): BrowserHostLeaseRegistry =>
  new BrowserHostLeaseRegistry({
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    reconnectGraceMs
  })

const attachHost = (
  leases: BrowserHostLeaseRegistry,
  browserHostClientId: string,
  options?: { connectionId?: string; reconnect?: boolean }
) =>
  leases.attach({
    browserHostClientId,
    connectionId: options?.connectionId ?? `connection-${browserHostClientId}`,
    pairedDeviceId: `device-${browserHostClientId}`,
    hostCapabilities: ['webview'],
    ...(options?.reconnect
      ? {
          pageInventoryProtocolVersion: 1 as const,
          pageInventory: [],
          leaseReconnectProtocolVersion: 1 as const
        }
      : {})
  })

const authority = (
  browserPageId: string,
  placement: RuntimeBrowserClientPlacement
): BrowserClientPageAuthority => ({
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserPageId,
  browserHostClientId: placement.browserHostClientId,
  browserHostGeneration: placement.browserHostGeneration,
  pageHostGeneration: placement.pageHostGeneration
})

afterEach(() => {
  vi.useRealTimers()
})

describe('browser host lease placement retirement', () => {
  it('makes exact client placements terminal before explicit lease release settles', async () => {
    const leases = registry()
    const host = attachHost(leases, 'host-a')
    const placement = leases.placeClientPage('page-a', 'host-a')
    if (placement.kind !== 'client') {
      throw new Error('expected client placement')
    }

    host.release()

    expect(() => leases.requireClientPage(authority('page-a', placement))).toThrow(
      'browser_page_retirement_pending'
    )
    const retirement = leases.beginPageRetirement('page-a', placement)
    expect(leases.cancelPageRetirement(retirement)).toBe(false)
    await expect(host.whenFenced).resolves.toBe('released')
  })

  it('upgrades an existing retirement to non-cancellable after host loss', () => {
    const leases = registry()
    const host = attachHost(leases, 'host-a')
    const placement = leases.placeClientPage('page-a', 'host-a')
    const retirement = leases.beginPageRetirement('page-a', placement)

    host.release()

    expect(leases.beginPageRetirement('page-a', placement)).toBe(retirement)
    expect(leases.cancelPageRetirement(retirement)).toBe(false)
    expect(leases.completePageRetirement(retirement)).toBe(true)
  })

  it('leaves other hosts and server placements live', () => {
    const leases = registry()
    const hostA = attachHost(leases, 'host-a')
    attachHost(leases, 'host-b')
    const placementA = leases.placeClientPage('page-a', 'host-a')
    const placementB = leases.placeClientPage('page-b', 'host-b')
    const server = leases.placeServerPage('page-server')
    if (placementA.kind !== 'client' || placementB.kind !== 'client') {
      throw new Error('expected client placements')
    }

    hostA.release()

    const retirementA = leases.beginPageRetirement('page-a', placementA)
    expect(leases.cancelPageRetirement(retirementA)).toBe(false)
    expect(leases.requireClientPage(authority('page-b', placementB))).toBe(placementB)
    const retirementB = leases.beginPageRetirement('page-b', placementB)
    expect(leases.cancelPageRetirement(retirementB)).toBe(true)
    const serverRetirement = leases.beginPageRetirement('page-server', server)
    expect(leases.cancelPageRetirement(serverRetirement)).toBe(true)
  })

  it('preserves placements throughout negotiated reconnect grace', () => {
    vi.useFakeTimers()
    const leases = registry(1_000)
    const host = attachHost(leases, 'host-a', { reconnect: true })
    const placement = leases.placeClientPage('page-a', 'host-a')

    host.disconnect()

    const retirement = leases.beginPageRetirement('page-a', placement)
    expect(leases.cancelPageRetirement(retirement)).toBe(true)
    expect(leases.getPlacement('page-a')).toBe(placement)
  })

  it('retires on grace expiry and legacy disconnect', async () => {
    vi.useFakeTimers()
    const leases = registry(1_000)
    const reconnecting = attachHost(leases, 'host-a', { reconnect: true })
    const reconnectingPlacement = leases.placeClientPage('page-a', 'host-a')
    const legacy = attachHost(leases, 'host-b')
    const legacyPlacement = leases.placeClientPage('page-b', 'host-b')

    reconnecting.disconnect()
    await vi.advanceTimersByTimeAsync(1_000)
    const expiredRetirement = leases.beginPageRetirement('page-a', reconnectingPlacement)
    expect(leases.cancelPageRetirement(expiredRetirement)).toBe(false)

    legacy.disconnect()
    const legacyRetirement = leases.beginPageRetirement('page-b', legacyPlacement)
    expect(leases.cancelPageRetirement(legacyRetirement)).toBe(false)
  })

  it('does not let late old-generation cleanup retire a replacement', () => {
    const leases = registry()
    const first = attachHost(leases, 'host-a')
    const firstPlacement = leases.placeClientPage('page-a', 'host-a')
    const replacementHost = attachHost(leases, 'host-a', { connectionId: 'connection-b' })
    const firstRetirement = leases.beginPageRetirement('page-a', firstPlacement)

    expect(leases.cancelPageRetirement(firstRetirement)).toBe(false)
    expect(leases.completePageRetirement(firstRetirement)).toBe(true)
    const replacement = leases.placeClientPage('page-a', 'host-a')

    first.release()

    expect(leases.getPlacement('page-a')).toBe(replacement)
    const replacementRetirement = leases.beginPageRetirement('page-a', replacement)
    expect(leases.cancelPageRetirement(replacementRetirement)).toBe(true)
    replacementHost.release()
  })

  it('retains placement capacity until exact retirement completion', () => {
    const leases = registry()
    const host = attachHost(leases, 'host-a')
    const placements = Array.from({ length: 256 }, (_, index) =>
      leases.placeClientPage(`page-${index}`, 'host-a')
    )

    host.release()

    expect(() => leases.placeServerPage('page-overflow')).toThrow('browser_page_placement_capacity')
    const retirement = leases.beginPageRetirement('page-0', placements[0]!)
    expect(leases.cancelPageRetirement(retirement)).toBe(false)
    expect(leases.completePageRetirement(retirement)).toBe(true)
    expect(leases.placeServerPage('page-after-cleanup')).toEqual({ kind: 'server' })
  })
})
