import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as environmentStore from '../../shared/runtime-environment-store'

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
  closeRemoteRuntimeRequestConnectionMock
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
  closeRemoteRuntimeRequestConnectionMock: vi.fn()
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
  closeRemoteRuntimeRequestConnection: closeRemoteRuntimeRequestConnectionMock
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
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('starts and stops streaming subscriptions for a saved remote runtime', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    const close = vi.fn()
    const sendBinary = vi.fn()
    const markUsedSpy = vi.spyOn(environmentStore, 'markEnvironmentUsed')
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (_pairing, _method, _params, _timeoutMs, callbacks) => {
        callbacks.onResponse({
          id: 'stream-1',
          ok: true,
          result: { type: 'subscribed' },
          _meta: { runtimeId: 'runtime-remote' }
        })
        callbacks.onResponse({
          id: 'stream-1',
          ok: true,
          result: { type: 'data', chunk: 'hello' },
          _meta: { runtimeId: 'runtime-remote' }
        })
        callbacks.onBinary(new Uint8Array([1, 2, 3]))
        return { requestId: 'stream-1', close, sendBinary }
      }
    )

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const sent: unknown[] = []
    const destroyedListenerRemoved = vi.fn()
    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const result = await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: (_channel: string, payload: unknown) => sent.push(payload),
          once: vi.fn(),
          removeListener: destroyedListenerRemoved
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        timeoutMs: 25,
        subscriptionId: 'preload-sub-1'
      }
    )

    expect(result.requestId).toBe('stream-1')
    expect(result.subscriptionId).toBe('preload-sub-1')
    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768' }),
      'terminal.subscribe',
      { terminal: 't1' },
      25,
      expect.any(Object)
    )
    expect(sent).toEqual([
      expect.objectContaining({ subscriptionId: result.subscriptionId, type: 'response' }),
      expect.objectContaining({ subscriptionId: result.subscriptionId, type: 'response' }),
      expect.objectContaining({ subscriptionId: result.subscriptionId, type: 'binary' })
    ])
    expect(markUsedSpy).toHaveBeenCalledTimes(1)

    const binaryListener = onMock.mock.calls.find(
      (call) => call[0] === 'runtimeEnvironments:subscriptionBinary'
    )?.[1] as (_event: unknown, args: unknown) => void
    const bytes = new Uint8Array([9, 8, 7])
    binaryListener({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId, bytes })
    expect(sendBinary).toHaveBeenCalledWith(bytes)

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(
      await unsubscribe({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: true
    })
    expect(close).toHaveBeenCalled()
    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))
    markUsedSpy.mockRestore()
  })

  it('rejects cross-window streaming subscription control', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    const close = vi.fn()
    const sendBinary = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockResolvedValue({
      requestId: 'stream-1',
      close,
      sendBinary
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

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
          removeListener: vi.fn()
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        subscriptionId: 'owned-sub'
      }
    )

    const binaryListener = onMock.mock.calls.find(
      (call) => call[0] === 'runtimeEnvironments:subscriptionBinary'
    )?.[1] as (_event: unknown, args: unknown) => void
    binaryListener(
      { sender: { id: 2 } },
      { subscriptionId: result.subscriptionId, bytes: new Uint8Array([1]) }
    )
    expect(sendBinary).not.toHaveBeenCalled()

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(
      await unsubscribe({ sender: { id: 2 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: false
    })
    expect(close).not.toHaveBeenCalled()

    expect(
      await unsubscribe({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: true
    })
    expect(close).toHaveBeenCalled()
  })

  it('closes a streaming subscription that resolves after the sender is destroyed', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    const close = vi.fn()
    let resolveSubscribe: (value: {
      requestId: string
      close: () => void
      sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
    }) => void = () => {}
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve
        })
    )

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    let destroyed = false
    let destroyedHandler: unknown = null
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
    const resultPromise = subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => destroyed,
          send: vi.fn(),
          once: vi.fn((_event: string, handler: () => void) => {
            destroyedHandler = () => {
              destroyed = true
              handler()
            }
          }),
          removeListener: destroyedListenerRemoved
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        subscriptionId: 'late-sub'
      }
    )

    await vi.waitFor(() => {
      expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalled()
    })
    expect(destroyedHandler).toBeTypeOf('function')
    ;(destroyedHandler as () => void)()
    resolveSubscribe({ requestId: 'stream-late', close, sendBinary: vi.fn() })

    await expect(resultPromise).resolves.toEqual({
      subscriptionId: 'late-sub',
      requestId: 'stream-late'
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(await unsubscribe({ sender: { id: 1 } }, { subscriptionId: 'late-sub' })).toEqual({
      unsubscribed: false
    })
  })

  it.each([
    { method: 'terminal.multiplex', includeExpectedRevision: true },
    { method: 'browser.screencast', includeExpectedRevision: true },
    { method: 'terminal.multiplex', includeExpectedRevision: false },
    { method: 'browser.screencast', includeExpectedRevision: false }
  ])(
    'closes a pending $method subscription after same-id re-pair (expected revision: $includeExpectedRevision)',
    async ({ method, includeExpectedRevision }) => {
      registerRuntimeEnvironmentHandlers(store as never)
      const close = vi.fn()
      const sendBinary = vi.fn(() => true)
      let emitRemoteBinary: (bytes: Uint8Array<ArrayBufferLike>) => void = () => {}
      let resolveSubscribe: (value: {
        requestId: string
        close: () => void
        sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
      }) => void = () => {}
      subscribeRemoteRuntimeRequestMock.mockImplementation(
        (_pairing, _method, _params, _timeoutMs, callbacks) => {
          emitRemoteBinary = callbacks.onBinary
          return new Promise((resolve) => {
            resolveSubscribe = resolve
          })
        }
      )

      const add = handler<
        { name: string; pairingCode: string },
        { environment: { id: string; name: string } }
      >('runtimeEnvironments:addFromPairingCode')
      const added = await add(null, { name: 'desk', pairingCode: pairingCode() })
      const savedEnvironment = environmentStore.resolveEnvironment(
        userDataPath,
        added.environment.id
      )
      const pairingRevision = savedEnvironment.pairingRevision ?? savedEnvironment.createdAt
      const senderSend = vi.fn()
      const subscribe = handler<
        {
          selector: string
          method: string
          params?: unknown
          subscriptionId: string
          expectedEnvironmentPairingRevision?: number
        },
        { subscriptionId: string; requestId: string }
      >('runtimeEnvironments:subscribe')
      const resultPromise = subscribe(
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
          method,
          params: {},
          subscriptionId: `pending-${method}-${includeExpectedRevision ? 'current' : 'legacy'}`,
          ...(includeExpectedRevision
            ? { expectedEnvironmentPairingRevision: pairingRevision }
            : {})
        }
      )

      await vi.waitFor(() => expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledTimes(1))
      environmentStore.updateEnvironmentFromPairingCode(userDataPath, added.environment.id, {
        pairingCode: pairingCode('ws://127.0.0.1:7678')
      })
      invalidateRuntimeEnvironmentTransport(added.environment.id)

      emitRemoteBinary(new Uint8Array([1, 2, 3]))
      expect(senderSend).not.toHaveBeenCalled()
      resolveSubscribe({ requestId: 'retired-stream', close, sendBinary })

      await expect(resultPromise).rejects.toThrow(
        'Runtime environment pairing changed; refresh and try again'
      )
      expect(close).toHaveBeenCalledTimes(1)

      const binaryListener = onMock.mock.calls.find(
        (call) => call[0] === 'runtimeEnvironments:subscriptionBinary'
      )?.[1] as (_event: unknown, args: unknown) => void
      binaryListener(
        { sender: { id: 1 } },
        {
          subscriptionId: `pending-${method}-${includeExpectedRevision ? 'current' : 'legacy'}`,
          bytes: new Uint8Array([4, 5, 6])
        }
      )
      expect(sendBinary).not.toHaveBeenCalled()
    }
  )

  it('removes the destroyed listener when streaming subscription setup rejects', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    subscribeRemoteRuntimeRequestMock.mockRejectedValue(new Error('connect failed'))

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

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

    await expect(
      subscribe(
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
          subscriptionId: 'failed-sub'
        }
      )
    ).rejects.toThrow('connect failed')

    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))
  })
})
