import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import {
  releaseRuntimeBrowserClientPageRecord,
  retainRuntimeBrowserClientPageRecord
} from './runtime-browser-client-page-release'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

type FencedPageReleaseRuntime = ReturnType<typeof createRuntime>

afterEach(() => {
  vi.useRealTimers()
})

describe('fenced client page retention', () => {
  it('keeps the runtime page and its session tab when a lease is released', () => {
    const runtime = createRuntime()
    const leases = getBrowserHostLeaseRegistry(runtime)
    const host = attachHost(runtime, 'host-a')
    const placement = placeClientPage(runtime, 'page-a', 'host-a')
    publishPage(runtime, 'page-a', placement)

    host.release()

    // The tab outlives the desktop that placed it; only the placement it can no longer serve goes.
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-a')?.placement).toEqual(placement)
    expect(leases.getPlacement('page-a')).toBeUndefined()
    expect(runtime.retireRuntimeOwnedBrowserSessionTab).not.toHaveBeenCalled()
    expect(runtime.notifyMobileSessionTabsChanged).toHaveBeenCalledWith('workspace-a')
  })

  it('keeps pages whose lease fences after its reconnect grace expires', async () => {
    vi.useFakeTimers()
    const runtime = createRuntime()
    const host = attachHost(runtime, 'host-a', { reconnect: true })
    publishPage(runtime, 'page-a', placeClientPage(runtime, 'page-a', 'host-a'))
    publishPage(runtime, 'page-b', placeClientPage(runtime, 'page-b', 'host-a'))

    host.disconnect()
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-a')).toBeDefined()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(
      getRuntimeBrowserPageRegistry(runtime)
        .listPages()
        .map((page) => page.browserPageId)
    ).toEqual(['page-a', 'page-b'])
    expect(runtime.retireRuntimeOwnedBrowserSessionTab).not.toHaveBeenCalled()
    await expect(host.whenFenced).resolves.toBe('released')
  })

  // Why the fixture has to publish a loading page: every other case here publishes a settled one,
  // so the republish that settles it reads the same as no republish at all.
  it('settles a retained page that was still loading when its host quit', () => {
    const runtime = createRuntime()
    const host = attachHost(runtime, 'host-a')
    const placement = placeClientPage(runtime, 'page-a', 'host-a')
    publishPage(runtime, 'page-a', placement, { loading: true })

    host.release()

    // Nothing can drive the page any more, so a spinner left standing would never resolve.
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-a')?.loading).toBe(false)
  })

  it('leaves pages hosted by a live lease alone', () => {
    const runtime = createRuntime()
    const fenced = attachHost(runtime, 'host-a')
    attachHost(runtime, 'host-b')
    const retained = placeClientPage(runtime, 'page-a', 'host-a')
    publishPage(runtime, 'page-a', retained)
    const survivor = placeClientPage(runtime, 'page-b', 'host-b')
    publishPage(runtime, 'page-b', survivor)
    const leases = getBrowserHostLeaseRegistry(runtime)

    fenced.release()

    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-a')?.placement).toEqual(retained)
    expect(leases.getPlacement('page-a')).toBeUndefined()
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-b')?.placement).toEqual(survivor)
    expect(leases.getPlacement('page-b')).toEqual(survivor)
    expect(runtime.notifyMobileSessionTabsChanged).toHaveBeenCalledOnce()
  })

  it('keeps the old record when a replacing attach fences the previous lease', () => {
    const runtime = createRuntime()
    attachHost(runtime, 'host-a')
    const placement = placeClientPage(runtime, 'page-a', 'host-a')
    publishPage(runtime, 'page-a', placement)

    // Why: the replacement is the same desktop returning, and recovery re-places the page onto it.
    attachHost(runtime, 'host-a', { connectionId: 'connection-b' })

    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-a')?.placement).toEqual(placement)
    expect(runtime.retireRuntimeOwnedBrowserSessionTab).not.toHaveBeenCalled()
  })

  it('keeps a runtime page a newer placement already owns', () => {
    const runtime = createRuntime()
    const stale = Object.freeze({
      kind: 'client' as const,
      browserHostClientId: 'host-a',
      browserHostGeneration: 1,
      pageHostGeneration: 1
    })
    publishPage(runtime, 'page-a', { ...stale, browserHostGeneration: 2 })

    // Why: a fence never authorizes touching a record another generation now owns.
    expect(retainRuntimeBrowserClientPageRecord(runtime, 'page-a', stale)).toBe(false)
    expect(releaseRuntimeBrowserClientPageRecord(runtime, 'page-a', stale)).toBe(false)
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-a')).toBeDefined()
    expect(runtime.notifyMobileSessionTabsChanged).not.toHaveBeenCalled()
    expect(runtime.retireRuntimeOwnedBrowserSessionTab).not.toHaveBeenCalled()
  })

  it('still destroys a page on the explicitly destructive path', () => {
    const runtime = createRuntime()
    attachHost(runtime, 'host-a')
    const placement = placeClientPage(runtime, 'page-a', 'host-a')
    publishPage(runtime, 'page-a', placement)

    // Worktree removal and unrecoverable recovery must keep dropping the record outright.
    expect(releaseRuntimeBrowserClientPageRecord(runtime, 'page-a', placement)).toBe(true)
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-a')).toBeUndefined()
    expect(runtime.retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledWith(
      'workspace-a',
      'page-a'
    )
  })

  it('retains the remaining fenced pages when one page retention throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = createRuntime()
    const leases = getBrowserHostLeaseRegistry(runtime)
    const host = attachHost(runtime, 'host-a')
    publishPage(runtime, 'page-a', placeClientPage(runtime, 'page-a', 'host-a'))
    publishPage(runtime, 'page-b', placeClientPage(runtime, 'page-b', 'host-a'))
    runtime.notifyMobileSessionTabsChanged.mockImplementationOnce(() => {
      throw new Error('session tab republish failed')
    })

    // A lease past the point of return must not strand pages behind one failing retention.
    expect(() => host.release()).not.toThrow()

    expect(runtime.notifyMobileSessionTabsChanged).toHaveBeenCalledTimes(2)
    expect(getRuntimeBrowserPageRegistry(runtime).listPages()).toHaveLength(2)
    expect(leases.getPlacement('page-b')).toBeUndefined()
  })

  it('disarms the reconnect grace timer when the lease is released outright', async () => {
    vi.useFakeTimers()
    const runtime = createRuntime()
    const host = attachHost(runtime, 'host-a', { reconnect: true })
    publishPage(runtime, 'page-a', placeClientPage(runtime, 'page-a', 'host-a'))

    host.disconnect()
    expect(vi.getTimerCount()).toBe(1)
    host.release()

    expect(vi.getTimerCount()).toBe(0)
    await expect(host.whenFenced).resolves.toBe('released')
  })
})

function createRuntime() {
  return {
    getRuntimeId: () => 'runtime-a',
    notifyMobileSessionTabsChanged: vi.fn((_workspaceId: string) => {}),
    retireRuntimeOwnedBrowserSessionTab: vi.fn((_workspaceId: string, _pageId: string) => {})
  }
}

function attachHost(
  runtime: FencedPageReleaseRuntime,
  browserHostClientId: string,
  options: { connectionId?: string; reconnect?: boolean } = {}
) {
  return getBrowserHostLeaseRegistry(runtime).attach({
    browserHostClientId,
    connectionId: options.connectionId ?? `connection-${browserHostClientId}`,
    pairedDeviceId: `device-${browserHostClientId}`,
    hostCapabilities: ['webview'],
    ...(options.reconnect
      ? {
          pageInventoryProtocolVersion: 1 as const,
          pageInventory: [],
          leaseReconnectProtocolVersion: 1 as const
        }
      : {})
  })
}

function placeClientPage(
  runtime: FencedPageReleaseRuntime,
  browserPageId: string,
  browserHostClientId: string
): RuntimeBrowserClientPlacement {
  const placement = getBrowserHostLeaseRegistry(runtime).placeClientPage(
    browserPageId,
    browserHostClientId
  )
  if (placement.kind !== 'client') {
    throw new Error('expected client placement')
  }
  return placement
}

function publishPage(
  runtime: FencedPageReleaseRuntime,
  browserPageId: string,
  placement: RuntimeBrowserClientPlacement,
  options: { loading?: boolean } = {}
): void {
  getRuntimeBrowserPageRegistry(runtime).publishClientPage({
    browserPageId,
    workspaceId: 'workspace-a',
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    placement,
    url: 'https://example.internal/',
    loading: options.loading ?? false,
    active: false
  })
}
