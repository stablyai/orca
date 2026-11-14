import { describe, expect, it } from 'vitest'
import type { BrowserClientHostedPageInventory } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { createBrowserHostLeaseState } from '../leases/browser-host-lease-attachment'
import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import { BrowserHostPagePlacementRegistry } from './browser-host-page-placement'
import { BrowserHostPageReconciliationOrchestrator } from './browser-host-page-reconciliation-orchestration'
import type { BrowserHostRuntimePageIntent } from './browser-host-page-reconciliation-plan'

// Test refusals here: adoption swallows them, making refusal indistinguishable from no-op externally.
const authority = { authorityRuntimeId: 'runtime-new', authorityEpoch: 'epoch-new' }

describe('browser host page reconciliation preconditions', () => {
  it('refuses a second attempt while one is still in flight on the same lease', async () => {
    const orchestrator = new BrowserHostPageReconciliationOrchestrator(
      authority,
      new BrowserHostPagePlacementRegistry(authority)
    )
    const state = leaseState({ pageInventory: [oldPage('page-a')] })
    state.executionHostGrants.grant('native:runtime-new:1')
    const controller = new AbortController()
    const inFlight = orchestrator
      .adopt(state, [reclaimIntent('page-a', 8)], { signal: controller.signal })
      .catch(() => undefined)

    await expect(orchestrator.adopt(state, [reclaimIntent('page-a', 9)])).rejects.toThrow(
      'browser_host_page_reconciliation_pending'
    )

    controller.abort(new Error('test cleanup'))
    await inFlight
  })
})

function leaseState(
  options: { pageInventory?: BrowserClientHostedPageInventory[]; legacy?: boolean } = {}
): BrowserHostLeaseState {
  return createBrowserHostLeaseState({
    ...authority,
    generation: 1,
    input: {
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      ...(options.legacy
        ? {}
        : { pageInventoryProtocolVersion: 1, pageReconciliationProtocolVersion: 1 })
    },
    pageInventory: options.legacy ? undefined : (options.pageInventory ?? [])
  })
}

function oldPage(browserPageId: string): BrowserClientHostedPageInventory {
  return {
    authorityRuntimeId: 'runtime-new',
    authorityEpoch: 'epoch-old',
    browserHostClientId: 'host-a',
    browserHostGeneration: 4,
    browserPageId,
    pageHostGeneration: 7,
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-new:1',
    state: 'active',
    currentUrl: 'https://remote.internal/'
  }
}

function reclaimIntent(
  browserPageId: string,
  pageHostGeneration: number
): BrowserHostRuntimePageIntent {
  return {
    ...authority,
    browserHostClientId: 'host-a',
    browserHostGeneration: 1,
    browserPageId,
    pageHostGeneration,
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-new:1',
    reclaimFrom: { ...oldPage(browserPageId), pairedDeviceId: 'device-a' }
  }
}
