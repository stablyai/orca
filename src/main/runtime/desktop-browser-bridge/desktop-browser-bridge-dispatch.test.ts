import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY
} from '../../../shared/desktop-browser-bridge-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'
import { defineMethod } from '../rpc/core'
import { RpcDispatcher } from '../rpc/dispatcher'
import { DESKTOP_BROWSER_BRIDGE_RPC_METHODS } from '../rpc/methods/browser/desktop-browser-bridge'
import { BrowserTarget } from '../../../shared/rpc-contract/rpc-param-primitives'
import { Goto } from '../../../shared/rpc-contract/browser/browser-params'
import { BrowserOpenUrlParams } from '../../../shared/rpc-contract/browser/browser-tab-create-params'
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
})
