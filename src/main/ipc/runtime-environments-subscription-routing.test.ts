import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../shared/protocol-version'

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

import { registerRuntimeEnvironmentHandlers } from './runtime-environments'
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

  it('keeps browser and terminal heavy streams on dedicated subscription sockets', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    const close = vi.fn()
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    subscribeRemoteRuntimeRequestMock.mockResolvedValue({
      requestId: 'browser-stream',
      close,
      sendBinary: vi.fn()
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn()
        }
      },
      { selector: 'desk', method: 'browser.screencast', params: { pageId: 'page-1' } }
    )
    await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn()
        }
      },
      { selector: 'desk', method: 'terminal.multiplex', params: { client: { id: 'client-1' } } }
    )

    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      'browser.screencast',
      { pageId: 'page-1' },
      15_000,
      expect.any(Object)
    )
    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      'terminal.multiplex',
      { client: { id: 'client-1' } },
      15_000,
      expect.any(Object)
    )
    expect(subscribeRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })

  it('routes passive subscriptions through shared control when supported', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    subscribeRemoteRuntimeSharedControlRequestMock.mockResolvedValue({
      requestId: 'tabs-shared',
      close: vi.fn(),
      sendBinary: vi.fn()
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
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
            removeListener: vi.fn()
          }
        },
        { selector: 'desk', method: 'session.tabs.subscribeAll' }
      )
    ).resolves.toMatchObject({ requestId: 'tabs-shared' })

    expect(subscribeRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      'session.tabs.subscribeAll',
      undefined,
      15_000,
      expect.any(Object)
    )
    expect(subscribeRemoteRuntimeRequestMock).not.toHaveBeenCalled()
  })

  it('keeps shared-control subscriptions retained across transient errors until final close', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    const close = vi.fn()
    const senderSend = vi.fn()
    const destroyedListenerRemoved = vi.fn()
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    subscribeRemoteRuntimeSharedControlRequestMock.mockResolvedValue({
      requestId: 'tabs-shared',
      close,
      sendBinary: vi.fn()
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const result = await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: senderSend,
          once: vi.fn(),
          removeListener: destroyedListenerRemoved
        }
      },
      {
        selector: 'desk',
        method: 'session.tabs.subscribeAll',
        subscriptionId: 'shared-sub'
      }
    )

    const callbacks = subscribeRemoteRuntimeSharedControlRequestMock.mock.calls[0]![5] as {
      onError: (error: { code: string; message: string }) => void
      onClose: () => void
    }
    callbacks.onError({ code: 'reconnecting', message: 'temporary drop' })

    expect(senderSend).toHaveBeenCalledWith('runtimeEnvironments:subscriptionEvent', {
      subscriptionId: 'shared-sub',
      type: 'error',
      code: 'reconnecting',
      message: 'temporary drop'
    })
    expect(destroyedListenerRemoved).not.toHaveBeenCalled()

    callbacks.onClose()
    expect(senderSend).toHaveBeenCalledWith('runtimeEnvironments:subscriptionEvent', {
      subscriptionId: 'shared-sub',
      type: 'close'
    })
    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(
      await unsubscribe({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: false
    })
    expect(close).not.toHaveBeenCalled()
  })

  it('falls back to legacy passive subscriptions when shared control is unsupported', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: { runtimeId: 'runtime-remote', capabilities: [] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    subscribeRemoteRuntimeRequestMock.mockResolvedValue({
      requestId: 'tabs-legacy',
      close: vi.fn(),
      sendBinary: vi.fn()
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
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
            removeListener: vi.fn()
          }
        },
        { selector: 'desk', method: 'session.tabs.subscribeAll' }
      )
    ).resolves.toMatchObject({ requestId: 'tabs-legacy' })

    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      'session.tabs.subscribeAll',
      undefined,
      15_000,
      expect.any(Object)
    )
    expect(subscribeRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })
})
