import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'
import { BrowserHostLeaseRegistry } from './browser-host/browser-host-lease-registry'
import { routeRuntimeBrowserClientAutomation } from './runtime-browser-client-automation'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

describe('runtime browser client automation routing', () => {
  it('surfaces missing host capability and exact client execution failures', async () => {
    const legacy = await createFixture({ automation: false })
    await expect(
      routeRuntimeBrowserClientAutomation({
        method: 'browser.click',
        params: { page: 'page-a', x: 10 },
        pages: legacy.pages,
        leases: legacy.leases,
        resolveWorkspace: legacy.resolveWorkspace
      })
    ).rejects.toThrow('browser_host_capability_unavailable')

    const failed = await createFixture()
    const routing = routeRuntimeBrowserClientAutomation({
      method: 'browser.click',
      params: { page: 'page-a', x: 10 },
      pages: failed.pages,
      leases: failed.leases,
      resolveWorkspace: failed.resolveWorkspace
    })
    await failed.waitForCommand()
    failed.settle({ status: 'failed', errorCode: 'browser_client_page_automation_failed' })
    await expect(routing).rejects.toThrow('browser_client_page_automation_failed')
  })
})

async function createFixture(options: { automation?: boolean } = {}) {
  const leases = new BrowserHostLeaseRegistry({
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a'
  })
  const lease = leases.attach({
    browserHostClientId: 'host-a',
    connectionId: 'connection-a',
    pairedDeviceId: 'device-a',
    hostCapabilities: options.automation === false ? ['webview'] : ['webview', 'automation-v1'],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    pageInventory: [],
    pageReconciliationProtocolVersion: 1
  }).lease
  let command: BrowserClientHostCommandEvent | undefined
  let commandWaiter: ((event: BrowserClientHostCommandEvent) => void) | undefined
  leases.attachCommandDelivery(
    {
      authorityEpoch: lease.authorityEpoch,
      browserHostClientId: lease.browserHostClientId,
      browserHostGeneration: lease.browserHostGeneration,
      pairedDeviceId: lease.pairedDeviceId
    },
    (event) => {
      command = event
      commandWaiter?.(event)
      commandWaiter = undefined
    }
  )
  const creation = leases.createClientPage({
    browserPageId: 'page-a',
    browserHostClientId: 'host-a',
    pairedDeviceId: 'device-a',
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-a:7'
  })
  if (!command) {
    throw new Error('expected browser client create command')
  }
  settleCommand(command, { status: 'completed' })
  const placement = await creation
  command = undefined
  const pages = new RuntimeBrowserPageRegistry()
  pages.publishClientPage({
    browserPageId: 'page-a',
    workspaceId: 'workspace-a',
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-a:7',
    placement,
    url: 'https://example.test/',
    loading: false,
    active: true
  })
  const resolveWorkspace = vi.fn(async () => ({ id: 'workspace-a' }))
  function settleCommand(
    event: BrowserClientHostCommandEvent,
    result: BrowserClientHostCommandResult
  ) {
    leases.settleClientPageCommand(
      {
        authorityEpoch: lease.authorityEpoch,
        browserHostClientId: lease.browserHostClientId,
        browserHostGeneration: lease.browserHostGeneration,
        pairedDeviceId: lease.pairedDeviceId,
        connectionId: lease.connectionId
      },
      {
        authorityRuntimeId: event.authorityRuntimeId,
        authorityEpoch: event.authorityEpoch,
        browserHostClientId: event.browserHostClientId,
        browserHostGeneration: event.browserHostGeneration,
        pageCommandProtocolVersion: event.pageCommandProtocolVersion,
        ...(event.pageReconciliationProtocolVersion
          ? { pageReconciliationProtocolVersion: event.pageReconciliationProtocolVersion }
          : {}),
        browserPageId: event.browserPageId,
        pageHostGeneration: event.pageHostGeneration,
        commandSequence: event.commandSequence,
        commandId: event.commandId,
        result
      }
    )
  }
  return {
    leases,
    pages,
    resolveWorkspace,
    get command() {
      return command
    },
    waitForCommand() {
      if (command) {
        return Promise.resolve(command)
      }
      return new Promise<BrowserClientHostCommandEvent>((resolve) => {
        commandWaiter = resolve
      })
    },
    settle(result: BrowserClientHostCommandResult) {
      if (!command) {
        throw new Error('expected browser client command')
      }
      settleCommand(command, result)
    }
  }
}
