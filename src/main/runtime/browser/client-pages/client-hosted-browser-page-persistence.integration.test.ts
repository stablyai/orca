/** Exercise runtime persistence wiring with a fake session store.
 * Real Store writes are covered by store-runtime-authored-session-writes.test.ts. */
import { describe, expect, it } from 'vitest'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import { createProfile } from './client-hosted-browser-persistence-test-harness'
import { getBrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry-instance'
import { isRestoredClientHostedBrowserPlacement } from './client-hosted-browser-page-persistence'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const WT = 'repo-1::/tmp/worktree-a'

function startRuntime(profile: ReturnType<typeof createProfile>): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(profile.store, undefined, {})
  runtime.rehydrateClientHostedBrowserPages()
  return runtime
}

function placeAndPublish(runtime: OrcaRuntimeService, browserPageId: string): void {
  const placement = getBrowserHostLeaseRegistry(runtime).placeClientPage(browserPageId, 'host-a')
  if (placement.kind !== 'client') {
    throw new Error('expected client placement')
  }
  getRuntimeBrowserPageRegistry(runtime).publishClientPage({
    browserPageId,
    workspaceId: WT,
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    placement,
    pairedDeviceId: 'device-a',
    url: 'https://example.internal/docs',
    title: 'Internal docs',
    loading: false,
    active: true
  })
}

function attachHost(runtime: OrcaRuntimeService) {
  return getBrowserHostLeaseRegistry(runtime).attach({
    browserHostClientId: 'host-a',
    connectionId: 'connection-host-a',
    pairedDeviceId: 'device-a',
    hostCapabilities: ['webview']
  })
}

describe('client-hosted browser page persistence through the runtime', () => {
  it('hands the page to a replacement runtime as a held row', () => {
    const profile = createProfile()
    const first = startRuntime(profile)
    attachHost(first)
    placeAndPublish(first, 'page-a')
    first.notifyMobileSessionTabsChanged(WT)

    const replacement = startRuntime(profile)

    const restored = getRuntimeBrowserPageRegistry(replacement).getPage('page-a')
    expect(restored).toMatchObject({
      workspaceId: WT,
      url: 'https://example.internal/docs',
      pairedDeviceId: 'device-a',
      loading: false,
      active: false
    })
    expect(
      isRestoredClientHostedBrowserPlacement(restored!.placement as RuntimeBrowserClientPlacement)
    ).toBe(true)
    expect(getBrowserHostLeaseRegistry(replacement).getPlacement('page-a')).toBeUndefined()
  })

  it('takes the page back out of the session when it is closed', () => {
    const profile = createProfile()
    const runtime = startRuntime(profile)
    attachHost(runtime)
    placeAndPublish(runtime, 'page-a')
    runtime.notifyMobileSessionTabsChanged(WT)

    const page = getRuntimeBrowserPageRegistry(runtime).getPage('page-a')!
    getRuntimeBrowserPageRegistry(runtime).retirePage('page-a', page.placement)
    runtime.notifyMobileSessionTabsChanged(WT)

    expect(profile.session.clientHostedBrowserPagesByWorktree?.[WT]).toBeUndefined()
    expect(getRuntimeBrowserPageRegistry(startRuntime(profile)).listPages()).toEqual([])
  })
})
