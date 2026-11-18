import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_PAGE_TOOLS_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY
} from '../../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'
import { defineMethod } from '../rpc/core'
import { RpcDispatcher } from '../rpc/dispatcher'
import { DESKTOP_BROWSER_BRIDGE_RPC_METHODS } from '../rpc/methods/browser/desktop-browser-bridge'
import { BrowserTarget } from '../../../shared/rpc-contract/rpc-param-primitives'
import { Goto, SetDevice } from '../../../shared/rpc-contract/browser/browser-params'
import {
  BrowserOpenUrlParams,
  BrowserTabCreateParams
} from '../../../shared/rpc-contract/browser/browser-tab-create-params'
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
const localHostBrowser = vi.fn(async () => ({}))

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
  }),
  defineMethod({
    name: 'browser.tabCreate',
    permission: 'workspace',
    params: BrowserTabCreateParams,
    handler: () => localHostBrowser()
  }),
  defineMethod({
    name: 'browser.setDevice',
    permission: 'workspace',
    params: SetDevice,
    handler: () => localHostBrowser()
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
  localHostBrowser.mockClear()
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

  it("keeps commands the desktop won't run off this host's own browser", async () => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime({ localBrowser: true })
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const { events } = await attachDesktop(dispatcher)

    await expect(
      cliCall(dispatcher, 'browser.cookie.get', { worktree: 'path:/srv/app' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_not_forwarded' }
    })
    await expect(
      cliCall(dispatcher, 'browser.tabCreate', {
        url: 'https://example.com',
        worktree: 'path:/srv/app',
        profileId: 'work'
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(localCookie).not.toHaveBeenCalled()
    expect(localHostBrowser).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
  })

  it.each([
    {
      name: 'a desktop that serves page tools gets',
      capabilities: [DESKTOP_BROWSER_BRIDGE_PAGE_TOOLS_CAPABILITY],
      forwards: true
    },
    { name: 'an older desktop never gets', capabilities: [], forwards: false }
  ])('$name device emulation', async ({ capabilities, forwards }) => {
    setDesktopBrowserBridgeHostEnabled(true)
    const { runtime } = orcadRuntime({ localBrowser: true })
    const dispatcher = new RpcDispatcher({ runtime, methods: METHODS })
    const { events } = await attachDesktop(dispatcher, {
      ...DESKTOP,
      clientCapabilities: [DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY, ...capabilities]
    })

    const call = cliCall(dispatcher, 'browser.setDevice', {
      name: 'iPhone 14',
      worktree: 'path:/srv/app'
    })
    if (forwards) {
      await vi.waitFor(() => expect(events).toHaveLength(2))
      expect(events[1]).toMatchObject({
        type: 'request',
        method: 'browser.setDevice',
        params: { name: 'iPhone 14', worktree: 'id:repo-1::/srv/app' }
      })
    } else {
      await expect(call).resolves.toMatchObject({
        ok: false,
        error: { code: 'desktop_browser_bridge_not_forwarded' }
      })
      expect(events).toHaveLength(1)
    }
    expect(localHostBrowser).not.toHaveBeenCalled()
  })
})
