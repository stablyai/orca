import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_REMOTE_PANEL_CLOSED_CHANNEL } from '../../shared/plugins/frames/plugin-remote-panel'
import type { PluginService } from '../plugins/plugin-service'

type StreamEvent =
  | { type: 'response'; response: unknown }
  | { type: 'error'; code: string; message: string }
  | { type: 'close' }

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  subscribe: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => unknown) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: mocks.subscribe
}))
vi.mock('../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ name: 'work-mac' })
}))

const { registerPluginRemotePanelHandlers } = await import('./plugin-remote-panel-ipc')

const LOCAL_TOKEN = 'l'.repeat(43)
const HOST_TOKEN = 'h'.repeat(43)

function sender(): EventEmitter & {
  id: number
  send: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), {
    id: 7,
    send: vi.fn(),
    isDestroyed: () => false
  })
}

function setup() {
  const service = {
    whenReady: vi.fn().mockResolvedValue(undefined),
    options: { userDataPath: '/tmp/orca-test' },
    findValidPlugin: () => ({ consentFingerprint: 'fp-1' }),
    panels: {
      sessionCaller: () => ({
        pluginKey: 'acme.notes',
        caller: { id: 'panel-1', surface: 'panel', contributionId: 'main' }
      })
    }
  }
  const stream: { emit?: (event: StreamEvent) => void } = {}
  const subscription = {
    requestId: 'r',
    close: vi.fn(),
    sendBinary: vi.fn(),
    sendRequest: vi.fn()
  }
  mocks.subscribe.mockImplementation(
    async (
      _userData: string,
      _selector: string,
      _method: string,
      _params: unknown,
      _timeout: number,
      callbacks: { onEvent: (event: StreamEvent) => void }
    ) => {
      stream.emit = callbacks.onEvent
      return subscription
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only the members stubbed above.
  const panels = registerPluginRemotePanelHandlers(service as unknown as PluginService)
  const window = sender()
  const bind = async () => {
    const bound = mocks.handlers.get('plugins:bindRemotePanel')?.(
      { sender: window },
      { sessionToken: LOCAL_TOKEN, environmentId: 'env-1' }
    )
    await vi.waitFor(() => expect(stream.emit).toBeDefined())
    stream.emit?.({
      type: 'response',
      response: {
        id: 'r',
        ok: true,
        result: { type: 'ready', sessionToken: HOST_TOKEN },
        _meta: { runtimeId: 'host' }
      }
    })
    return bound
  }
  return { panels, window, subscription, stream, bind }
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.subscribe.mockReset()
})

describe('paired-host plugin panels', () => {
  it("sends a bound panel's calls to its host with the host's session token", async () => {
    const { panels, window, subscription, bind } = setup()
    await expect(bind()).resolves.toEqual({
      bound: true,
      hostName: 'work-mac'
    })
    expect(mocks.subscribe.mock.calls[0]?.slice(1, 4)).toEqual([
      'env-1',
      'plugins.panelSession',
      { pluginKey: 'acme.notes', panelId: 'main', consentFingerprint: 'fp-1' }
    ])
    subscription.sendRequest.mockResolvedValue({
      id: 'q',
      ok: true,
      result: { outcome: { ok: true, value: 'from work-mac' } },
      _meta: { runtimeId: 'host' }
    })

    const outcome = await panels.forward(window.id, {
      sessionToken: LOCAL_TOKEN,
      action: 'panel.request',
      params: { name: 'items' }
    })

    expect(outcome).toEqual({ ok: true, value: 'from work-mac' })
    expect(subscription.sendRequest).toHaveBeenCalledWith(
      'plugins.panelAction',
      {
        sessionToken: HOST_TOKEN,
        action: 'panel.request',
        params: { name: 'items' }
      },
      expect.any(Number)
    )
    expect(panels.forward(window.id, { sessionToken: 'o'.repeat(43), action: 'x' })).toBeNull()
  })

  it('holds pushes until the panel listens and hands the panel back when the host goes', async () => {
    const { panels, window, subscription, stream, bind } = setup()
    await bind()
    const push = (data: number) =>
      stream.emit?.({
        type: 'response',
        response: {
          id: 'r',
          ok: true,
          result: { type: 'push', push: { data } },
          _meta: { runtimeId: 'host' }
        }
      })

    push(1)
    expect(window.send).not.toHaveBeenCalled()
    expect(panels.openPush(window.id, LOCAL_TOKEN)).toBe(true)
    push(2)
    expect(window.send.mock.calls).toEqual([
      ['plugins:panelPush', { sessionToken: LOCAL_TOKEN, push: { data: 1 } }],
      ['plugins:panelPush', { sessionToken: LOCAL_TOKEN, push: { data: 2 } }]
    ])

    stream.emit?.({ type: 'close' })
    expect(subscription.close).toHaveBeenCalled()
    expect(window.send).toHaveBeenLastCalledWith(PLUGIN_REMOTE_PANEL_CLOSED_CHANNEL, {
      sessionToken: LOCAL_TOKEN,
      reason: 'work-mac disconnected'
    })
    expect(panels.forward(window.id, { sessionToken: LOCAL_TOKEN, action: 'x' })).toBeNull()
  })

  it('leaves the panel on this computer when the host refuses it', async () => {
    const { window, stream } = setup()
    const bound = mocks.handlers.get('plugins:bindRemotePanel')?.(
      { sender: window },
      { sessionToken: LOCAL_TOKEN, environmentId: 'env-1' }
    )
    await vi.waitFor(() => expect(stream.emit).toBeDefined())
    stream.emit?.({
      type: 'response',
      response: {
        id: 'r',
        ok: false,
        error: { code: 'runtime_error', message: 'not installed' }
      }
    })
    await expect(bound).resolves.toEqual({
      bound: false,
      reason: 'work-mac: not installed'
    })
    expect(window.send).not.toHaveBeenCalled()
  })
})
