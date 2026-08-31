import { describe, expect, it, vi } from 'vitest'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { BrowserClientHostedPageInventory } from '../../../../shared/browser-client-host-protocol'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from '../../runtime-browser-page-registry'
import type { BrowserExecutionHostKeyResolution } from '../../runtime-browser-client-page-adoption'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { BROWSER_CLIENT_HOST_METHODS } from './browser-client-host'

const RUNTIME_ID = 'runtime-new'
const HOST_CLIENT_ID = 'host-adopt'
const WORKSPACE_ID = 'workspace-a'
const EXECUTION_HOST_KEY = 'native:runtime-new:1'

function orphanedPage(
  overrides: Partial<BrowserClientHostedPageInventory> = {}
): BrowserClientHostedPageInventory {
  return {
    authorityRuntimeId: 'runtime-old',
    authorityEpoch: 'epoch-old',
    browserHostClientId: HOST_CLIENT_ID,
    browserHostGeneration: 2,
    browserPageId: 'page-a',
    pageHostGeneration: 3,
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-old:1',
    state: 'active',
    currentUrl: 'https://remote.internal/left-here',
    workspaceId: WORKSPACE_ID,
    ...overrides
  }
}

/**
 * Attaches through the real RPC method, answering every command the runtime publishes the way the
 * client host would. Everything adoption does at attach has to survive this path or it ships broken.
 */
function attachHost(
  pageInventory: readonly BrowserClientHostedPageInventory[],
  options: {
    resolveExecutionHostKey?: (workspaceId: string) => Promise<BrowserExecutionHostKeyResolution>
    browserHostClientId?: string
    pairedDeviceId?: string
  } = {}
) {
  const browserHostClientId = options.browserHostClientId ?? HOST_CLIENT_ID
  const pairedDeviceId = options.pairedDeviceId ?? 'device-a'
  const cleanups = new Map<string, () => void>()
  const markClientHostedPagesReconciled = vi.fn()
  const notifyMobileSessionTabsChanged = vi.fn()
  const hostRuntime = {
    getRuntimeId: () => RUNTIME_ID,
    getStartedAt: () => 1,
    resolveBrowserExecutionHostKeyForWorkspace:
      options.resolveExecutionHostKey ??
      (() =>
        Promise.resolve<BrowserExecutionHostKeyResolution>({
          status: 'resolved',
          executionHostKey: EXECUTION_HOST_KEY
        })),
    markClientHostedPagesReconciled,
    notifyMobileSessionTabsChanged,
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup)
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({
    runtime: hostRuntime,
    methods: BROWSER_CLIENT_HOST_METHODS
  })
  const replies: string[] = []
  const answered = new Set<string>()
  const dispatch = dispatcher.dispatchStreaming(
    {
      id: `browser-host:${browserHostClientId}`,
      authToken: 'bound-by-websocket',
      method: 'browser.clientHost.attach',
      params: {
        authorityRuntimeId: RUNTIME_ID,
        browserHostClientId,
        hostCapabilities: ['webview'],
        pageCommandProtocolVersion: 1,
        pageInventoryProtocolVersion: 1,
        pageInventory: pageInventory.map((page) => ({ ...page, browserHostClientId })),
        pageReconciliationProtocolVersion: 1,
        leaseReconnectProtocolVersion: 1
      }
    },
    (reply) => {
      replies.push(reply)
      const event = JSON.parse(reply).result
      if (event?.type !== 'command' || answered.has(event.commandId)) {
        return
      }
      answered.add(event.commandId)
      void dispatcher.dispatchStreaming(
        {
          id: `command-result:${event.commandId}`,
          authToken: 'bound-by-websocket',
          method: 'browser.clientHost.commandResult',
          params: { ...event, result: { status: 'completed' } }
        },
        () => {},
        {
          connectionId: 'connection-a',
          clientKind: 'runtime',
          pairedDeviceId,
          clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
        }
      )
    },
    {
      connectionId: 'connection-a',
      clientKind: 'runtime',
      pairedDeviceId,
      clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
    }
  )
  return {
    hostRuntime,
    dispatch,
    replies,
    cleanups,
    markClientHostedPagesReconciled,
    notifyMobileSessionTabsChanged,
    commands: () =>
      replies.map((reply) => JSON.parse(reply).result).filter((event) => event?.type === 'command')
  }
}

describe('browser.clientHost.attach adoption', () => {
  it('takes the predecessor runtime pages back into the page registry', async () => {
    const rig = attachHost([orphanedPage()])

    await vi.waitFor(() => {
      expect(getRuntimeBrowserPageRegistry(rig.hostRuntime).getPage('page-a')).toBeDefined()
    })
    const adopted = getRuntimeBrowserPageRegistry(rig.hostRuntime).getPage('page-a')
    expect(adopted).toMatchObject({
      workspaceId: WORKSPACE_ID,
      executionHostKey: EXECUTION_HOST_KEY,
      url: 'https://remote.internal/left-here',
      active: false
    })
    expect(rig.notifyMobileSessionTabsChanged).toHaveBeenCalledWith(WORKSPACE_ID)
    expect(getBrowserHostLeaseRegistry(rig.hostRuntime).getPlacement('page-a')).toMatchObject({
      kind: 'client',
      browserHostClientId: HOST_CLIENT_ID
    })

    rig.cleanups.get(`browser-client-host:${HOST_CLIENT_ID}`)?.()
    await rig.dispatch
  })

  it('closes the reconciliation window for the attaching client once every page is taken back', async () => {
    const rig = attachHost([orphanedPage({ browserPageId: 'page-b' })], {
      browserHostClientId: 'host-window',
      pairedDeviceId: 'device-window'
    })

    await vi.waitFor(() =>
      expect(rig.markClientHostedPagesReconciled).toHaveBeenCalledWith('device-window')
    )

    rig.cleanups.get('browser-client-host:host-window')?.()
    await rig.dispatch
  })

  it('keeps the window open when a page could not be taken back yet', async () => {
    const rig = attachHost([orphanedPage({ browserPageId: 'page-c' })], {
      browserHostClientId: 'host-held',
      pairedDeviceId: 'device-held',
      resolveExecutionHostKey: () => Promise.resolve({ status: 'unavailable' })
    })

    await vi.waitFor(() => expect(rig.replies.length).toBeGreaterThan(0))
    await Promise.resolve()
    await Promise.resolve()
    // The guest is live and record-less; declaring this client reconciled would let it cull the row.
    expect(rig.markClientHostedPagesReconciled).not.toHaveBeenCalled()
    expect(rig.commands()).toEqual([])

    rig.cleanups.get('browser-client-host:host-held')?.()
    await rig.dispatch
  })

  it('does not re-enter recovery for a page it just adopted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rig = attachHost([orphanedPage({ browserPageId: 'page-d' })], {
      browserHostClientId: 'host-recovery',
      pairedDeviceId: 'device-recovery'
    })

    await vi.waitFor(() =>
      expect(rig.markClientHostedPagesReconciled).toHaveBeenCalledWith('device-recovery')
    )
    await vi.waitFor(() => expect(rig.commands().length).toBeGreaterThanOrEqual(2))
    await Promise.resolve()
    await Promise.resolve()

    // The adopted page's inventory entry still names the predecessor by construction, so recovery
    // would call it stale and warn once per adopted page on every restart.
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('client page recovery failed'))
    ).toEqual([])
    warn.mockRestore()

    rig.cleanups.get('browser-client-host:host-recovery')?.()
    await rig.dispatch
  })
})
