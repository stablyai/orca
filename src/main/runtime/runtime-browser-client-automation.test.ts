import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'
import type { BrowserError } from '../browser/browser-error'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import { routeRuntimeBrowserClientAutomation } from './runtime-browser-client-automation'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

describe('runtime browser client automation routing', () => {
  it('routes an explicit client page and returns its exact command result', async () => {
    const fixture = await createFixture()
    const routing = routeRuntimeBrowserClientAutomation({
      method: 'browser.click',
      params: { page: 'page-a', x: 10, y: 20 },
      pages: fixture.pages,
      leases: fixture.leases,
      resolveWorkspace: fixture.resolveWorkspace
    })

    const command = await fixture.waitForCommand()
    expect(command).toMatchObject({
      browserPageId: 'page-a',
      command: {
        type: 'automation',
        method: 'browser.click',
        params: { page: 'page-a', x: 10, y: 20 }
      }
    })
    fixture.settle({ status: 'completed', value: { clicked: true } })
    await expect(routing).resolves.toEqual({ handled: true, result: { clicked: true } })
    expect(fixture.resolveWorkspace).not.toHaveBeenCalled()
  })

  it('routes the active client page in an explicit folder or worktree workspace', async () => {
    const fixture = await createFixture()
    const routing = routeRuntimeBrowserClientAutomation({
      method: 'browser.snapshot',
      params: { worktree: 'id:folder:folder-a' },
      pages: fixture.pages,
      leases: fixture.leases,
      resolveWorkspace: fixture.resolveWorkspace
    })

    await fixture.waitForCommand()
    fixture.settle({ status: 'completed', value: { url: 'https://example.test/' } })
    await expect(routing).resolves.toEqual({
      handled: true,
      result: { url: 'https://example.test/' }
    })
    expect(fixture.resolveWorkspace).toHaveBeenCalledWith('id:folder:folder-a')
  })

  it('keeps server pages and non-targeted browser methods on the server', async () => {
    const fixture = await createFixture()

    await expect(
      routeRuntimeBrowserClientAutomation({
        method: 'browser.click',
        params: { page: 'server-page', x: 10 },
        pages: fixture.pages,
        leases: fixture.leases,
        resolveWorkspace: fixture.resolveWorkspace
      })
    ).resolves.toEqual({ handled: false })
    await expect(
      routeRuntimeBrowserClientAutomation({
        method: 'browser.tabList',
        params: { page: 'page-a' },
        pages: fixture.pages,
        leases: fixture.leases,
        resolveWorkspace: fixture.resolveWorkspace
      })
    ).resolves.toEqual({ handled: false })
    expect(fixture.command).toBeUndefined()
  })

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

  it('returns actionable recovery when the host disconnects before dispatch', async () => {
    const fixture = await createFixture()
    fixture.disconnect()

    await expect(
      routeRuntimeBrowserClientAutomation({
        method: 'browser.click',
        params: { page: 'page-a', x: 10 },
        pages: fixture.pages,
        leases: fixture.leases,
        resolveWorkspace: fixture.resolveWorkspace
      })
    ).rejects.toMatchObject({
      code: 'browser_host_unavailable',
      data: {
        retryable: true,
        browserPageId: 'page-a',
        worktreeId: 'workspace-a',
        lastKnownUrl: 'https://example.test/',
        nextSteps: expect.arrayContaining([
          expect.stringContaining('Reconnect'),
          expect.stringContaining('server-hosted')
        ])
      }
    } satisfies Partial<BrowserError>)
    expect(fixture.command).toBeUndefined()
    expect(fixture.pages.listPages()).toHaveLength(1)
  })

  it('allows a retry when the transport refuses the command before dispatch', async () => {
    const fixture = await createFixture()
    fixture.rejectDelivery()

    await expect(
      routeRuntimeBrowserClientAutomation({
        method: 'browser.click',
        params: { page: 'page-a', x: 10 },
        pages: fixture.pages,
        leases: fixture.leases,
        resolveWorkspace: fixture.resolveWorkspace
      })
    ).rejects.toMatchObject({
      code: 'browser_host_unavailable',
      data: { retryable: true, browserPageId: 'page-a' }
    } satisfies Partial<BrowserError>)
    expect(fixture.command).toBeUndefined()
  })

  it('preserves the ledger for a reconnect after transport refusal', async () => {
    const fixture = await createFixture()
    fixture.rejectDelivery()
    await expect(
      routeRuntimeBrowserClientAutomation({
        method: 'browser.click',
        params: { page: 'page-a', x: 10 },
        pages: fixture.pages,
        leases: fixture.leases,
        resolveWorkspace: fixture.resolveWorkspace
      })
    ).rejects.toMatchObject({ code: 'browser_host_unavailable' })

    fixture.reconnect()
    const routing = routeRuntimeBrowserClientAutomation({
      method: 'browser.click',
      params: { page: 'page-a', x: 10 },
      pages: fixture.pages,
      leases: fixture.leases,
      resolveWorkspace: fixture.resolveWorkspace
    })
    await fixture.waitForCommand()
    fixture.settle({ status: 'completed', value: { clicked: true } })
    await expect(routing).resolves.toEqual({ handled: true, result: { clicked: true } })
  })

  it('routes a safe retry after the same desktop reconnects', async () => {
    const fixture = await createFixture()
    fixture.disconnect()
    await expect(
      routeRuntimeBrowserClientAutomation({
        method: 'browser.click',
        params: { page: 'page-a', x: 10 },
        pages: fixture.pages,
        leases: fixture.leases,
        resolveWorkspace: fixture.resolveWorkspace
      })
    ).rejects.toMatchObject({ code: 'browser_host_unavailable' })

    fixture.reconnect()
    const routing = routeRuntimeBrowserClientAutomation({
      method: 'browser.click',
      params: { page: 'page-a', x: 10 },
      pages: fixture.pages,
      leases: fixture.leases,
      resolveWorkspace: fixture.resolveWorkspace
    })
    await fixture.waitForCommand()
    fixture.settle({ status: 'completed', value: { clicked: true } })

    await expect(routing).resolves.toEqual({ handled: true, result: { clicked: true } })
  })

  it('does not recommend a blind retry when the host is lost after dispatch', async () => {
    const fixture = await createFixture()
    const routing = routeRuntimeBrowserClientAutomation({
      method: 'browser.click',
      params: { page: 'page-a', x: 10 },
      pages: fixture.pages,
      leases: fixture.leases,
      resolveWorkspace: fixture.resolveWorkspace
    })

    await expect(fixture.waitForCommand()).resolves.toMatchObject({
      command: { type: 'automation', method: 'browser.click' }
    })
    fixture.releaseHost()

    await expect(routing).rejects.toMatchObject({
      code: 'browser_command_outcome_unknown',
      data: {
        retryable: false,
        browserPageId: 'page-a',
        nextSteps: expect.arrayContaining([
          expect.stringContaining('Inspect'),
          expect.stringContaining('confirming')
        ])
      }
    } satisfies Partial<BrowserError>)
  })
})

async function createFixture(options: { automation?: boolean } = {}) {
  const leases = new BrowserHostLeaseRegistry({
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a'
  })
  let host = leases.attach({
    browserHostClientId: 'host-a',
    connectionId: 'connection-a',
    pairedDeviceId: 'device-a',
    hostCapabilities: options.automation === false ? ['webview'] : ['webview', 'automation-v1'],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    pageInventory: [],
    pageReconciliationProtocolVersion: 1,
    leaseReconnectProtocolVersion: 1
  })
  let lease = host.lease
  let command: BrowserClientHostCommandEvent | undefined
  let commandWaiter: ((event: BrowserClientHostCommandEvent) => void) | undefined
  let deliveryAccepted = true
  let detachDelivery = attachDelivery()
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
  function attachDelivery() {
    return leases.attachCommandDelivery(
      {
        authorityEpoch: lease.authorityEpoch,
        browserHostClientId: lease.browserHostClientId,
        browserHostGeneration: lease.browserHostGeneration,
        pairedDeviceId: lease.pairedDeviceId
      },
      (event) => {
        if (!deliveryAccepted) {
          return false
        }
        command = event
        commandWaiter?.(event)
        commandWaiter = undefined
        return true
      }
    )
  }
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
    },
    rejectDelivery() {
      deliveryAccepted = false
      command = undefined
    },
    disconnect() {
      detachDelivery()
      host.disconnect()
      command = undefined
    },
    reconnect() {
      deliveryAccepted = true
      host = leases.attach({
        browserHostClientId: 'host-a',
        connectionId: 'connection-b',
        pairedDeviceId: 'device-a',
        hostCapabilities: options.automation === false ? ['webview'] : ['webview', 'automation-v1'],
        pageCommandProtocolVersion: 1,
        pageInventoryProtocolVersion: 1,
        pageInventory: [
          {
            authorityRuntimeId: lease.authorityRuntimeId,
            authorityEpoch: lease.authorityEpoch,
            browserHostClientId: lease.browserHostClientId,
            browserHostGeneration: lease.browserHostGeneration,
            browserPageId: 'page-a',
            pageHostGeneration: placement.pageHostGeneration,
            browserProfileId: 'default',
            executionHostKey: 'native:runtime-a:7',
            state: 'active',
            currentUrl: 'https://example.test/',
            workspaceId: 'workspace-a'
          }
        ],
        pageReconciliationProtocolVersion: 1,
        leaseReconnectProtocolVersion: 1
      })
      lease = host.lease
      detachDelivery = attachDelivery()
    },
    releaseHost() {
      host.release()
    }
  }
}
