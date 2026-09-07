import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  onMock,
  removeHandlerMock,
  removeAllListenersMock,
  getPathMock,
  sendRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeRequestMock,
  sendRemoteRuntimeConnectionRequestMock,
  sendRemoteRuntimeSharedControlRequestMock,
  subscribeRemoteRuntimeSharedControlRequestMock,
  getRemoteRuntimeSharedControlDiagnosticsMock,
  reconnectRemoteRuntimeSharedControlConnectionMock,
  retryRemoteRuntimeSharedControlConnectionsNowMock,
  closeRemoteRuntimeRequestConnectionMock,
  retirePairedRuntimeBrowserClientHostEnvironmentMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  getPathMock: vi.fn(),
  sendRemoteRuntimeRequestMock: vi.fn(),
  subscribeRemoteRuntimeRequestMock: vi.fn(),
  sendRemoteRuntimeConnectionRequestMock: vi.fn(),
  sendRemoteRuntimeSharedControlRequestMock: vi.fn(),
  subscribeRemoteRuntimeSharedControlRequestMock: vi.fn(),
  getRemoteRuntimeSharedControlDiagnosticsMock: vi.fn(),
  reconnectRemoteRuntimeSharedControlConnectionMock: vi.fn(),
  retryRemoteRuntimeSharedControlConnectionsNowMock: vi.fn(),
  closeRemoteRuntimeRequestConnectionMock: vi.fn(),
  retirePairedRuntimeBrowserClientHostEnvironmentMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock
}))

vi.mock('./runtime-environment-request-connections', () => ({
  sendRemoteRuntimeConnectionRequest: sendRemoteRuntimeConnectionRequestMock,
  sendRemoteRuntimeSharedControlRequest: sendRemoteRuntimeSharedControlRequestMock,
  subscribeRemoteRuntimeSharedControlRequest: subscribeRemoteRuntimeSharedControlRequestMock,
  getRemoteRuntimeSharedControlDiagnostics: getRemoteRuntimeSharedControlDiagnosticsMock,
  reconnectRemoteRuntimeSharedControlConnection: reconnectRemoteRuntimeSharedControlConnectionMock,
  retryRemoteRuntimeSharedControlConnectionsNow: retryRemoteRuntimeSharedControlConnectionsNowMock,
  retryRemoteRuntimeSharedControlConnectionNow: vi.fn(),
  ensureRemoteRuntimeSharedControlConnection: vi.fn(),
  pauseRemoteRuntimeSharedControlRetry: vi.fn(),
  closeRemoteRuntimeRequestConnection: closeRemoteRuntimeRequestConnectionMock
}))
vi.mock('../browser/paired-runtime-browser-client-host-runtime', () => ({
  retirePairedRuntimeBrowserClientHostEnvironment:
    retirePairedRuntimeBrowserClientHostEnvironmentMock
}))

import {
  invalidateRuntimeEnvironmentTransport,
  registerRuntimeEnvironmentHandlers
} from './runtime-environments'
import { channelHandlerLookup, pairingCode } from './runtime-environments-ipc-test-harness'

const handler = channelHandlerLookup(handleMock)

describe('registerRuntimeEnvironmentHandlers', () => {
  let userDataPath: string
  let activeRuntimeEnvironmentId: string | null
  let store: {
    getSettings: () => { activeRuntimeEnvironmentId: string | null }
    updateSettings: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-ipc-'))
    activeRuntimeEnvironmentId = null
    store = {
      getSettings: () => ({ activeRuntimeEnvironmentId }),
      updateSettings: vi.fn((updates: { activeRuntimeEnvironmentId: string | null }) => {
        activeRuntimeEnvironmentId = updates.activeRuntimeEnvironmentId
      })
    }
    getPathMock.mockReset()
    getPathMock.mockReturnValue(userDataPath)
    handleMock.mockReset()
    onMock.mockReset()
    removeHandlerMock.mockReset()
    removeAllListenersMock.mockReset()
    sendRemoteRuntimeRequestMock.mockReset()
    subscribeRemoteRuntimeRequestMock.mockReset()
    sendRemoteRuntimeConnectionRequestMock.mockReset()
    sendRemoteRuntimeSharedControlRequestMock.mockReset()
    subscribeRemoteRuntimeSharedControlRequestMock.mockReset()
    getRemoteRuntimeSharedControlDiagnosticsMock.mockReset()
    getRemoteRuntimeSharedControlDiagnosticsMock.mockReturnValue(null)
    reconnectRemoteRuntimeSharedControlConnectionMock.mockReset()
    retryRemoteRuntimeSharedControlConnectionsNowMock.mockReset()
    closeRemoteRuntimeRequestConnectionMock.mockReset()
    retirePairedRuntimeBrowserClientHostEnvironmentMock.mockReset()
    retirePairedRuntimeBrowserClientHostEnvironmentMock.mockResolvedValue(false)
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('closes streaming subscriptions when their saved runtime is removed', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    const close = vi.fn()
    const sendBinary = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockResolvedValue({
      requestId: 'stream-remove',
      close,
      sendBinary
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const destroyedListenerRemoved = vi.fn()
    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const result = await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: vi.fn(),
          once: vi.fn(),
          removeListener: destroyedListenerRemoved
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        subscriptionId: 'removed-env-sub'
      }
    )

    const remove = handler<{ selector: string }, { removed: { id: string; name: string } }>(
      'runtimeEnvironments:remove'
    )
    expect(remove(null, { selector: added.environment.id })).toMatchObject({
      removed: { id: added.environment.id, name: 'desk' }
    })

    expect(close).toHaveBeenCalledTimes(1)
    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(
      await unsubscribe({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: false
    })
  })

  it('tells the renderer when retiring the transport closes its streaming subscription', async () => {
    // Why: disconnect advances the transport generation before closing sockets.
    // Gating the terminal 'close' on that generation stranded the renderer with a
    // handle it believed was open, so every later subscribe wrote into a socket
    // main no longer owned — blank, wedged remote terminals after a reconnect.
    registerRuntimeEnvironmentHandlers(store as never)
    let transportCallbacks: {
      onResponse: (response: Record<string, unknown>) => void
      onClose: () => void
    } | null = null
    const close = vi.fn(() => {
      transportCallbacks?.onClose()
    })
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (
        _environment: unknown,
        _method: string,
        _params: unknown,
        _timeoutMs: number,
        callbacks: NonNullable<typeof transportCallbacks>
      ) => {
        transportCallbacks = callbacks
        return { requestId: 'multiplex-1', close, sendBinary: vi.fn() }
      }
    )

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const senderSend = vi.fn()
    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const subscribed = await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: senderSend,
          once: vi.fn(),
          removeListener: vi.fn()
        }
      },
      {
        selector: added.environment.id,
        method: 'terminal.multiplex',
        params: {},
        subscriptionId: 'multiplex-sub'
      }
    )

    const disconnect = handler<{ selector: string }, { disconnected: { id: string } }>(
      'runtimeEnvironments:disconnect'
    )
    disconnect(null, { selector: added.environment.id })

    const closeEvents = senderSend.mock.calls.filter(
      (call) =>
        call[0] === 'runtimeEnvironments:subscriptionEvent' &&
        (call[1] as { type?: string }).type === 'close'
    )
    expect(closeEvents).toEqual([
      [
        'runtimeEnvironments:subscriptionEvent',
        { subscriptionId: subscribed.subscriptionId, type: 'close' }
      ]
    ])
  })

  it("retires an environment's remaining subscriptions when one teardown throws", async () => {
    // Why: the sweep exists to retire dead handles, so a single failing teardown
    // must not strand the very sockets it was called to close.
    registerRuntimeEnvironmentHandlers(store as never)
    const closeCalls: string[] = []
    let streamCount = 0
    subscribeRemoteRuntimeRequestMock.mockImplementation(async () => {
      streamCount += 1
      const requestId = `stream-${streamCount}`
      return {
        requestId,
        close: () => {
          closeCalls.push(requestId)
          if (requestId === 'stream-1') {
            throw new Error('socket teardown exploded')
          }
        },
        sendBinary: vi.fn()
      }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const senderSend = vi.fn()
    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const sender = {
      sender: {
        id: 1,
        isDestroyed: () => false,
        send: senderSend,
        once: vi.fn(),
        removeListener: vi.fn()
      }
    }
    await subscribe(sender, {
      selector: added.environment.id,
      method: 'terminal.multiplex',
      params: {},
      subscriptionId: 'doomed-sub'
    })
    await subscribe(sender, {
      selector: added.environment.id,
      method: 'browser.screencast',
      params: {},
      subscriptionId: 'sibling-sub'
    })

    const disconnect = handler<{ selector: string }, { disconnected: { id: string } }>(
      'runtimeEnvironments:disconnect'
    )
    expect(() => disconnect(null, { selector: added.environment.id })).not.toThrow()

    expect(closeCalls).toEqual(['stream-1', 'stream-2'])
    expect(
      senderSend.mock.calls
        .filter((call) => (call[1] as { type?: string }).type === 'close')
        .map((call) => (call[1] as { subscriptionId: string }).subscriptionId)
    ).toEqual(['doomed-sub', 'sibling-sub'])

    // Both entries are gone, so a later unsubscribe finds nothing to release.
    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(await unsubscribe({ sender: { id: 1 } }, { subscriptionId: 'sibling-sub' })).toEqual({
      unsubscribed: false
    })
  })

  it('contains a throwing renderer send on a host-initiated close', async () => {
    // Why: this is the notifyClosed call site with no surrounding guard. A host
    // close arriving on a disposed render frame would otherwise throw out through
    // the transport's onClose and into the WebSocket close handler.
    registerRuntimeEnvironmentHandlers(store as never)
    let transportCallbacks: {
      onResponse: (response: Record<string, unknown>) => void
      onClose: () => void
    } | null = null
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (
        _environment: unknown,
        _method: string,
        _params: unknown,
        _timeoutMs: number,
        callbacks: NonNullable<typeof transportCallbacks>
      ) => {
        transportCallbacks = callbacks
        return { requestId: 'host-closed-stream', close: vi.fn(), sendBinary: vi.fn() }
      }
    )

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const senderSend = vi.fn((_channel: string, payload: { type: string }) => {
      if (payload.type === 'close') {
        throw new Error('Render frame was disposed')
      }
    })
    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: senderSend,
          once: vi.fn(),
          removeListener: vi.fn()
        }
      },
      {
        selector: added.environment.id,
        method: 'terminal.multiplex',
        params: {},
        subscriptionId: 'host-closed-sub'
      }
    )

    // The host closes the stream on its own; nothing wraps this call site.
    expect(() => transportCallbacks!.onClose()).not.toThrow()
    expect(
      senderSend.mock.calls.filter((call) => (call[1] as { type?: string }).type === 'close')
    ).toHaveLength(1)

    // The entry is still released, so a later unsubscribe finds nothing.
    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(await unsubscribe({ sender: { id: 1 } }, { subscriptionId: 'host-closed-sub' })).toEqual(
      {
        unsubscribed: false
      }
    )
  })

  it('retires remaining subscriptions when a liveness probe inside notifyClosed throws', async () => {
    // Why: notifyClosed guards its own send, but the sweep must not depend on
    // everything else inside it staying throw-free -- that is how the abandoned
    // -siblings defect comes back the next time a line is added there.
    registerRuntimeEnvironmentHandlers(store as never)
    const closedStreams: string[] = []
    let streamCount = 0
    subscribeRemoteRuntimeRequestMock.mockImplementation(async () => {
      streamCount += 1
      const requestId = `stream-${streamCount}`
      return {
        requestId,
        close: () => closedStreams.push(requestId),
        sendBinary: vi.fn()
      }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const deliveredCloses: string[] = []
    const senderSend = vi.fn(
      (_channel: string, payload: { subscriptionId: string; type: string }) => {
        if (payload.type === 'close') {
          deliveredCloses.push(payload.subscriptionId)
        }
      }
    )
    let probeShouldThrow = false
    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const sender = {
      sender: {
        id: 1,
        isDestroyed: () => {
          if (probeShouldThrow) {
            throw new Error('WebContents liveness probe exploded')
          }
          return false
        },
        send: senderSend,
        once: vi.fn(),
        removeListener: vi.fn()
      }
    }
    await subscribe(sender, {
      selector: added.environment.id,
      method: 'terminal.multiplex',
      params: {},
      subscriptionId: 'probe-throws-sub'
    })
    await subscribe(sender, {
      selector: added.environment.id,
      method: 'browser.screencast',
      params: {},
      subscriptionId: 'surviving-sub'
    })
    // Why: arm only after subscribe, whose own isDestroyed checks must succeed.
    probeShouldThrow = true

    const disconnect = handler<{ selector: string }, { disconnected: { id: string } }>(
      'runtimeEnvironments:disconnect'
    )
    expect(() => disconnect(null, { selector: added.environment.id })).not.toThrow()

    // Both transports still closed even though every notifyClosed probe threw.
    expect(closedStreams).toEqual(['stream-1', 'stream-2'])
    expect(deliveredCloses).toEqual([])
  })

  it('suppresses stale payloads from a retired transport but never re-sends its close', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    let transportCallbacks: {
      onResponse: (response: Record<string, unknown>) => void
      onClose: () => void
    } | null = null
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (
        _environment: unknown,
        _method: string,
        _params: unknown,
        _timeoutMs: number,
        callbacks: NonNullable<typeof transportCallbacks>
      ) => {
        transportCallbacks = callbacks
        return { requestId: 'multiplex-2', close: vi.fn(), sendBinary: vi.fn() }
      }
    )

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const senderSend = vi.fn()
    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: senderSend,
          once: vi.fn(),
          removeListener: vi.fn()
        }
      },
      {
        selector: added.environment.id,
        method: 'terminal.multiplex',
        params: {},
        subscriptionId: 'multiplex-stale'
      }
    )

    invalidateRuntimeEnvironmentTransport(added.environment.id)
    expect(retirePairedRuntimeBrowserClientHostEnvironmentMock).toHaveBeenCalledWith(
      added.environment.id,
      expect.objectContaining({ message: 'Runtime environment transport was invalidated' })
    )
    senderSend.mockClear()
    // A late frame from the retired socket must not reach the renderer...
    transportCallbacks!.onResponse({
      id: 'r1',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-a' }
    })
    // ...and its late close must not re-fire after the retirement already sent one.
    transportCallbacks!.onClose()
    expect(senderSend).not.toHaveBeenCalled()
  })
})
