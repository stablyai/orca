import { resetRuntimeEnvironmentStatusOwners } from './runtime-environment-request-connections'
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
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: getPathMock },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('../../../shared/remote-runtime/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock
}))

vi.mock('./runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('./runtime-environments-ipc-test-harness')
  return withRuntimeStatusOwners({
    sendRemoteRuntimeConnectionRequest: sendRemoteRuntimeConnectionRequestMock,
    sendRemoteRuntimeSharedControlRequest: sendRemoteRuntimeSharedControlRequestMock,
    subscribeRemoteRuntimeSharedControlRequest: subscribeRemoteRuntimeSharedControlRequestMock,
    getRemoteRuntimeSharedControlDiagnostics: getRemoteRuntimeSharedControlDiagnosticsMock,
    reconnectRemoteRuntimeSharedControlConnection:
      reconnectRemoteRuntimeSharedControlConnectionMock,
    retryRemoteRuntimeSharedControlConnectionsNow:
      retryRemoteRuntimeSharedControlConnectionsNowMock,
    ensureRemoteRuntimeSharedControlConnection: vi.fn(),
    pauseRemoteRuntimeSharedControlRetry: vi.fn(),
    closeRemoteRuntimeRequestConnection: closeRemoteRuntimeRequestConnectionMock
  })
})
vi.mock('../../browser/paired-runtime-browser-client-host-runtime', () => ({
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
    removeWorkspaceSessionHost: ReturnType<typeof vi.fn>
    setRemoteLayoutSnapshot: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-ipc-'))
    activeRuntimeEnvironmentId = null
    store = {
      getSettings: () => ({ activeRuntimeEnvironmentId }),
      removeWorkspaceSessionHost: vi.fn(),
      setRemoteLayoutSnapshot: vi.fn(),
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
    // An invalidation restarts status; left unanswered so it never settles mid-test.
    sendRemoteRuntimeRequestMock.mockReturnValue(new Promise(() => {}))
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
    resetRuntimeEnvironmentStatusOwners()
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
          on: vi.fn(),
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
    // Disconnect advances generation before close; the retired stream must still release its renderer handle.
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
          on: vi.fn(),
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
    // A teardown failure must not strand sibling subscriptions.
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
        on: vi.fn(),
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

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(await unsubscribe({ sender: { id: 1 } }, { subscriptionId: 'sibling-sub' })).toEqual({
      unsubscribed: false
    })
  })

  it('contains a throwing renderer send on a host-initiated close', async () => {
    // Host close reaches notifyClosed directly, outside any retirement sweep guard.
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
          on: vi.fn(),
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

    expect(() => transportCallbacks!.onClose()).not.toThrow()
    expect(
      senderSend.mock.calls.filter((call) => (call[1] as { type?: string }).type === 'close')
    ).toHaveLength(1)

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
    // Keep sweep isolation independent of notifyClosed internals, including a throwing lifetime probe.
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
        on: vi.fn(),
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
    // Subscription setup must pass its lifetime checks before the teardown probe starts throwing.
    probeShouldThrow = true

    const disconnect = handler<{ selector: string }, { disconnected: { id: string } }>(
      'runtimeEnvironments:disconnect'
    )
    expect(() => disconnect(null, { selector: added.environment.id })).not.toThrow()

    expect(closedStreams).toEqual(['stream-1', 'stream-2'])
    expect(deliveredCloses).toEqual([])
  })

  it('fences late payloads and duplicate close after full retirement', async () => {
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
          on: vi.fn(),
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

    await invalidateRuntimeEnvironmentTransport(added.environment.id)
    expect(retirePairedRuntimeBrowserClientHostEnvironmentMock).toHaveBeenCalledWith(
      added.environment.id,
      expect.objectContaining({ message: 'Runtime environment transport was invalidated' })
    )
    expect(closeRemoteRuntimeRequestConnectionMock).toHaveBeenCalledWith(added.environment.id)
    expect(senderSend).toHaveBeenCalledWith('runtimeEnvironments:subscriptionEvent', {
      subscriptionId: 'multiplex-stale',
      type: 'close'
    })
    senderSend.mockClear()
    // Retired sockets must neither deliver late frames nor duplicate their terminal close.
    transportCallbacks!.onResponse({
      id: 'r1',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-a' }
    })
    transportCallbacks!.onClose()
    expect(senderSend).not.toHaveBeenCalled()
  })

  it('restarts status for a re-paired server so renderers see its new pairing', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    // Real transport invalidation also drops the status owner.
    closeRemoteRuntimeRequestConnectionMock.mockImplementation(() =>
      resetRuntimeEnvironmentStatusOwners()
    )
    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })
    sendRemoteRuntimeRequestMock.mockClear()

    await invalidateRuntimeEnvironmentTransport(added.environment.id)
    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.anything(),
      'status.get',
      undefined,
      15_000,
      undefined,
      expect.anything(),
      expect.anything()
    )

    sendRemoteRuntimeRequestMock.mockClear()
    const disconnect = handler<{ selector: string }, unknown>('runtimeEnvironments:disconnect')
    await disconnect(null, { selector: added.environment.id })
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()
  })
})
