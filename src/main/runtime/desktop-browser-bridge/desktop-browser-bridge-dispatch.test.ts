import '../rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_SETTING_LABEL
} from '../../../shared/desktop-browser-bridge-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'
import { defineMethod } from '../rpc/core'
import { RpcDispatcher } from '../rpc/dispatcher'
import { DESKTOP_BROWSER_BRIDGE_RPC_METHODS } from '../rpc/methods/desktop-browser-bridge'
import { BrowserTarget } from '../../../shared/rpc-contract/rpc-param-primitives'
import { Goto } from '../../../shared/rpc-contract/browser-params'
import { BrowserOpenUrlParams } from '../../../shared/rpc-contract/browser-tab-create-params'
import {
  getDesktopBrowserBridgeRegistry,
  setDesktopBrowserBridgeHostEnabled
} from './desktop-browser-bridge-registry'
import { routeDesktopBrowserBridgeRpc } from './desktop-browser-bridge-route'

const ReadyEvent = z.object({ type: z.literal('ready'), attachmentId: z.string() })
const ForwardedEvent = z.object({ requestId: z.string() }).passthrough()

const localGoto = vi.fn(async () => ({ url: 'local', title: '' }))
const localCookie = vi.fn(async () => ({ cookies: [] }))
const localOpenUrl = vi.fn(async () => ({ browserPageId: 'paired-host-page' }))

const METHODS = [
  ...DESKTOP_BROWSER_BRIDGE_RPC_METHODS,
  defineMethod({
    name: 'browser.goto',
    permission: 'workspace',
    params: Goto,
    handler: () => localGoto()
  }),
  defineMethod({
    name: 'browser.cookie.get',
    permission: 'workspace',
    params: BrowserTarget,
    handler: () => localCookie()
  }),
  defineMethod({
    name: 'browser.openUrl',
    permission: 'workspace',
    params: BrowserOpenUrlParams,
    handler: () => localOpenUrl()
  })
]

function orcadRuntime(options: { localBrowser?: boolean } = {}) {
  const cleanups = new Map<string, () => void>()
  const runtime = {
    getRuntimeId: () => 'orcad-runtime',
    getStartedAt: () => 1,
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    routeDesktopBrowserBridgeRpc: (
      method: string,
      params: unknown,
      context: Parameters<OrcaRuntimeService['routeDesktopBrowserBridgeRpc']>[2]
    ) =>
      routeDesktopBrowserBridgeRpc({
        method,
        params,
        caller: context.caller,
        signal: context.signal,
        hostEnabled: true,
        registry: getDesktopBrowserBridgeRegistry(runtime),
        localBrowserAvailable: options.localBrowser === true,
        resolveWorkspace: async (selector) => ({
          id: selector === 'path:/srv/app' ? 'repo-1::/srv/app' : selector.replace(/^id:/, '')
        })
      })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only the members stubbed above.
  return { runtime: runtime as unknown as OrcaRuntimeService, cleanups }
}

const DESKTOP = {
  connectionId: 'desktop-socket',
  clientKind: 'runtime' as const,
  pairedDeviceId: 'desktop-device',
  clientCapabilities: [DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY]
}

async function attachDesktop(
  dispatcher: RpcDispatcher,
  options:
    | typeof DESKTOP
    | (Omit<typeof DESKTOP, 'clientCapabilities'> & { clientCapabilities: string[] }) = DESKTOP
) {
  const events: Record<string, unknown>[] = []
  const done = dispatcher.dispatchStreaming(
    {
      id: 'attach',
      authToken: 'bound-by-websocket',
      method: 'desktopBrowserBridge.attach',
      params: { bridgeClientId: 'desktop-a' }
    },
    (reply) => {
      const parsed = JSON.parse(reply)
      events.push(parsed.ok ? parsed.result : { error: parsed.error })
    },
    options
  )
  await vi.waitFor(() => expect(events.length).toBeGreaterThan(0))
  return { events, done }
}

function cliCall(dispatcher: RpcDispatcher, method: string, params: Record<string, unknown>) {
  return dispatcher.dispatch({ id: `cli-${method}`, authToken: 'owner', method, params })
}

afterEach(() => {
  setDesktopBrowserBridgeHostEnabled(false)
  localGoto.mockClear()
  localCookie.mockClear()
  localOpenUrl.mockClear()
})

describe('desktop browser bridge on orcad', () => {
  it('forwards an allowlisted CLI command to the attached desktop and returns its answer', async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const { events } = await attachDesktop(dispatcher)
    const ready = ReadyEvent.parse(events[0])

    const call = cliCall(dispatcher, 'browser.goto', {
      url: 'https://example.com',
      worktree: 'path:/srv/app'
    })
    await vi.waitFor(() => expect(events).toHaveLength(2))
    const forwarded = ForwardedEvent.parse(events[1])
    expect(forwarded).toMatchObject({
      type: 'request',
      method: 'browser.goto',
      workspaceId: 'repo-1::/srv/app',
      params: { url: 'https://example.com', worktree: 'id:repo-1::/srv/app' }
    })

    const spoofed = await dispatcher.dispatch(
      {
        id: 'spoof',
        authToken: 'bound',
        method: 'desktopBrowserBridge.result',
        params: {
          attachmentId: ready.attachmentId,
          requestId: forwarded.requestId,
          ok: true,
          result: { url: 'evil' }
        }
      },
      { ...DESKTOP, connectionId: 'other-socket' }
    )
    expect(spoofed).toMatchObject({ ok: true, result: { accepted: false } })

    const accepted = await dispatcher.dispatch(
      {
        id: 'answer',
        authToken: 'bound',
        method: 'desktopBrowserBridge.result',
        params: {
          attachmentId: ready.attachmentId,
          requestId: forwarded.requestId,
          ok: true,
          result: { url: 'https://example.com/', title: 'Example' }
        }
      },
      DESKTOP
    )
    expect(accepted).toMatchObject({ ok: true, result: { accepted: true } })
    await expect(call).resolves.toMatchObject({
      ok: true,
      result: { url: 'https://example.com/', title: 'Example' }
    })
    expect(localGoto).not.toHaveBeenCalled()
  })

  it('sends open-url to the attached desktop as the tab create it already runs', async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const { events } = await attachDesktop(dispatcher)
    const ready = ReadyEvent.parse(events[0])

    const call = cliCall(dispatcher, 'browser.openUrl', {
      url: 'https://example.com/',
      worktree: 'path:/srv/app'
    })
    await vi.waitFor(() => expect(events).toHaveLength(2))
    const forwarded = ForwardedEvent.parse(events[1])
    // Older desktops support tabCreate but not openUrl.
    expect(forwarded).toEqual({
      type: 'request',
      requestId: forwarded.requestId,
      method: 'browser.tabCreate',
      timeoutMs: expect.any(Number),
      workspaceId: 'repo-1::/srv/app',
      params: { url: 'https://example.com/', worktree: 'id:repo-1::/srv/app' }
    })
    await dispatcher.dispatch(
      {
        id: 'answer',
        authToken: 'bound',
        method: 'desktopBrowserBridge.result',
        params: {
          attachmentId: ready.attachmentId,
          requestId: forwarded.requestId,
          ok: true,
          result: { browserPageId: 'desktop-page' }
        }
      },
      DESKTOP
    )

    await expect(call).resolves.toMatchObject({
      ok: true,
      result: { browserPageId: 'desktop-page' }
    })
    expect(localOpenUrl).not.toHaveBeenCalled()
  })

  it('refuses a non-web open-url on the host before it reaches the desktop', async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const { events } = await attachDesktop(dispatcher)

    const response = await cliCall(dispatcher, 'browser.openUrl', {
      url: 'file:///etc/hosts',
      worktree: 'path:/srv/app'
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(events).toHaveLength(1)
  })

  it('names the setting for open-url when no desktop hosts or shares a browser', async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })

    const response = await cliCall(dispatcher, 'browser.openUrl', {
      url: 'https://example.com/',
      worktree: 'path:/srv/app'
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_unavailable' }
    })
    expect(response.ok ? '' : response.error.message).toContain(
      DESKTOP_BROWSER_BRIDGE_SETTING_LABEL
    )
    expect(localOpenUrl).not.toHaveBeenCalled()
  })

  it("leaves open-url to a desktop hosting this runtime's pages while none shares its browser", async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime({ localBrowser: true })
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })

    await expect(
      cliCall(dispatcher, 'browser.openUrl', {
        url: 'https://example.com/',
        worktree: 'path:/srv/app'
      })
    ).resolves.toMatchObject({ ok: true, result: { browserPageId: 'paired-host-page' } })
  })

  it('never forwards a command outside the allowlist', async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const { events } = await attachDesktop(dispatcher)

    const response = await cliCall(dispatcher, 'browser.cookie.get', { worktree: 'path:/srv/app' })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_not_forwarded' }
    })
    expect(events).toHaveLength(1)
    expect(localCookie).not.toHaveBeenCalled()
  })

  it('names the setting when no desktop is attached (setting off or an older desktop)', async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })

    const response = await cliCall(dispatcher, 'browser.goto', { url: 'https://example.com' })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_unavailable' }
    })
    expect(response.ok ? '' : response.error.message).toContain(
      DESKTOP_BROWSER_BRIDGE_SETTING_LABEL
    )
  })

  it('refuses an attach from a desktop that did not negotiate the capability', async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })

    const { events } = await attachDesktop(dispatcher, { ...DESKTOP, clientCapabilities: [] })

    expect(events[0]).toMatchObject({
      error: { message: 'desktop_browser_bridge_capability_required' }
    })
    expect(getDesktopBrowserBridgeRegistry(runtime).hasAttachment()).toBe(false)
  })

  it('refuses an attach from a phone or an unauthenticated socket', async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })

    const { events } = await attachDesktop(dispatcher, {
      ...DESKTOP,
      pairedDeviceId: ''
    })

    expect(events[0]).toMatchObject({
      error: { message: 'authenticated_desktop_browser_bridge_required' }
    })
  })

  it('a desktop runtime never serves the bridge', async () => {
    const { runtime } = orcadRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })

    const { events } = await attachDesktop(dispatcher)

    expect(events[0]).toMatchObject({ error: { message: 'desktop_browser_bridge_not_served' } })
  })

  it('detaching fails the waiting command and the next one names the setting', async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime, cleanups } = orcadRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const { events, done } = await attachDesktop(dispatcher)
    const call = cliCall(dispatcher, 'browser.goto', {
      url: 'https://example.com',
      worktree: 'path:/srv/app'
    })
    await vi.waitFor(() => expect(events).toHaveLength(2))

    for (const cleanup of cleanups.values()) {
      cleanup()
    }
    await done

    await expect(call).resolves.toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_unavailable' }
    })
    await expect(
      cliCall(dispatcher, 'browser.goto', { url: 'https://example.com' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'desktop_browser_bridge_unavailable' } })
  })

  it('leaves a host with its own headless browser on it while no desktop is attached', async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime({ localBrowser: true })
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })

    await expect(
      cliCall(dispatcher, 'browser.goto', { url: 'https://example.com' })
    ).resolves.toMatchObject({ ok: true, result: { url: 'local' } })
  })

  it('does not forward calls from a paired client, only the host CLI', async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime({ localBrowser: true })
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const { events } = await attachDesktop(dispatcher)

    const response = await dispatcher.dispatch(
      {
        id: 'paired',
        authToken: 'bound',
        method: 'browser.goto',
        params: { url: 'https://a.test' }
      },
      DESKTOP
    )

    expect(response).toMatchObject({ ok: true, result: { url: 'local' } })
    expect(events).toHaveLength(1)
  })

  it.each([
    {
      name: 'a cancel-capable desktop hears',
      capabilities: [DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY],
      cancels: true
    },
    { name: 'an older desktop never hears', capabilities: [], cancels: false }
  ])('$name that the CLI cancelled a forwarded command', async ({ capabilities, cancels }) => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const { events } = await attachDesktop(dispatcher, {
      ...DESKTOP,
      clientCapabilities: [DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY, ...capabilities]
    })
    const cli = new AbortController()

    const call = dispatcher.dispatch(
      {
        id: 'cli-goto',
        authToken: 'owner',
        method: 'browser.goto',
        params: { url: 'https://example.com', worktree: 'path:/srv/app' }
      },
      { signal: cli.signal }
    )
    await vi.waitFor(() => expect(events).toHaveLength(2))
    const forwarded = ForwardedEvent.parse(events[1])
    cli.abort()

    await expect(call).resolves.toMatchObject({ ok: false })
    expect(events.slice(2)).toEqual(
      cancels ? [{ type: 'cancel', requestId: forwarded.requestId }] : []
    )
  })
})
