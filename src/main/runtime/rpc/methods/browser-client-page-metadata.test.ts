import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry-instance'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { getRuntimeBrowserPageRegistry } from '../../runtime-browser-page-registry'
import { RpcDispatcher } from '../dispatcher'
import { BROWSER_CLIENT_HOST_METHODS } from './browser-client-host'

describe('browser.clientHost.pageMetadata RPC', () => {
  it('accepts only newer metadata and republishes session tabs after acceptance', async () => {
    const harness = await createHarness()

    expect(
      await dispatchMetadata(harness.dispatcher, metadata(harness.placement, 1))
    ).toMatchObject({ ok: true, result: { accepted: true } })
    expect(
      await dispatchMetadata(harness.dispatcher, {
        ...metadata(harness.placement, 1),
        title: 'Duplicate'
      })
    ).toMatchObject({ ok: true, result: { accepted: false } })
    expect(
      await dispatchMetadata(harness.dispatcher, metadata(harness.placement, 2))
    ).toMatchObject({ ok: true, result: { accepted: true } })
    expect(harness.notifySessionTabs).toHaveBeenCalledTimes(2)
    expect(harness.notifySessionTabs).toHaveBeenNthCalledWith(1, 'worktree-a')
    expect(getRuntimeBrowserPageRegistry(harness.runtime).getPage('page-a')).toMatchObject({
      metadataRevision: 2,
      title: 'Page 2',
      url: 'https://example.com/2'
    })

    await harness.close()
  })

  it('rejects stale page, paired-device, and connection authority', async () => {
    const harness = await createHarness()
    const params = metadata(harness.placement, 1)

    expect(
      await dispatchMetadata(harness.dispatcher, {
        ...params,
        pageHostGeneration: params.pageHostGeneration + 1
      })
    ).toMatchObject({ ok: false, error: { message: 'browser_page_placement_stale' } })
    expect(
      await dispatchMetadata(harness.dispatcher, params, { pairedDeviceId: 'device-b' })
    ).toMatchObject({ ok: false, error: { message: 'browser_host_lease_stale' } })
    expect(
      await dispatchMetadata(harness.dispatcher, params, { connectionId: 'connection-b' })
    ).toMatchObject({ ok: false, error: { message: 'browser_host_lease_stale' } })
    expect(harness.notifySessionTabs).not.toHaveBeenCalled()

    await harness.close()
  })

  it('requires metadata capability and leaves server pages unchanged', async () => {
    const harness = await createHarness()
    const params = metadata(harness.placement, 1)

    expect(
      await dispatchMetadata(harness.dispatcher, params, { clientCapabilities: [] })
    ).toMatchObject({
      ok: false,
      error: { message: 'browser_client_page_metadata_capability_required' }
    })
    getBrowserHostLeaseRegistry(harness.runtime).placeServerPage('server-page')
    expect(
      await dispatchMetadata(harness.dispatcher, { ...params, browserPageId: 'server-page' })
    ).toMatchObject({
      ok: false,
      error: { message: 'browser_client_page_placement_required' }
    })
    expect(getRuntimeBrowserPageRegistry(harness.runtime).getPage('server-page')).toBeUndefined()
    expect(harness.notifySessionTabs).not.toHaveBeenCalled()

    await harness.close()
  })
})

async function createHarness() {
  const cleanups = new Map<string, () => void>()
  const notifySessionTabs = vi.fn()
  const runtime = {
    getRuntimeId: () => 'runtime-a',
    getStartedAt: () => 1,
    // Attach adopts client-hosted pages from the reported inventory before recovery runs.
    resolveBrowserExecutionHostKeyForWorkspace: async () => undefined,
    markClientHostedPagesReconciled: () => {},
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    notifyMobileSessionTabsChanged: notifySessionTabs
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_CLIENT_HOST_METHODS })
  const replies: string[] = []
  const attached = dispatcher.dispatchStreaming(attachRequest(), (reply) => replies.push(reply), {
    connectionId: 'connection-a',
    clientKind: 'runtime',
    pairedDeviceId: 'device-a',
    clientCapabilities: CLIENT_CAPABILITIES
  })
  await vi.waitFor(() => expect(replies).toHaveLength(1))
  const placement = getBrowserHostLeaseRegistry(runtime).placeClientPage('page-a', 'host-a')
  if (placement.kind !== 'client') {
    throw new Error('expected client placement')
  }
  getRuntimeBrowserPageRegistry(runtime).publishClientPage({
    browserPageId: 'page-a',
    workspaceId: 'worktree-a',
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-a:1',
    placement,
    url: 'about:blank',
    loading: false,
    active: true
  })

  return {
    dispatcher,
    runtime,
    placement,
    notifySessionTabs,
    close: async () => {
      cleanups.get('browser-client-host:host-a')?.()
      await attached
    }
  }
}

async function dispatchMetadata(
  dispatcher: RpcDispatcher,
  params: Record<string, unknown>,
  overrides: {
    pairedDeviceId?: string
    connectionId?: string
    clientCapabilities?: typeof CLIENT_CAPABILITIES | readonly []
  } = {}
) {
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'page-metadata-a',
      authToken: 'bound-by-websocket',
      method: 'browser.clientHost.pageMetadata',
      params
    },
    (reply) => replies.push(reply),
    {
      clientKind: 'runtime',
      pairedDeviceId: 'device-a',
      connectionId: 'connection-a',
      clientCapabilities: CLIENT_CAPABILITIES,
      ...overrides
    }
  )
  return JSON.parse(replies[0]!)
}

function attachRequest() {
  return {
    id: 'browser-host:host-a',
    authToken: 'bound-by-websocket',
    method: 'browser.clientHost.attach',
    params: {
      authorityRuntimeId: 'runtime-a',
      browserHostClientId: 'host-a',
      hostCapabilities: ['webview']
    }
  }
}

function metadata(placement: RuntimeBrowserClientPlacement, revision: number) {
  return {
    ...placement,
    browserPageId: 'page-a',
    revision,
    url: `https://example.com/${revision}`,
    title: `Page ${revision}`,
    loading: false,
    canGoBack: revision > 1,
    canGoForward: false
  }
}

const CLIENT_CAPABILITIES = [
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
] as const
