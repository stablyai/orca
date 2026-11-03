import { terminalInputSend } from '../terminal/mobile-terminal-operations'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type * as MobileClipboardImage from './mobile-clipboard-image'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'
import { MobileTerminalInputSender } from '../terminal/mobile-terminal-input-sender'

const pasteboard = vi.hoisted(() => {
  const state: { image: { data: string } | null } = { image: null }
  return state
})

vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory()
}))
vi.mock('expo-clipboard', () => ({
  getStringAsync: async () => '',
  getImageAsync: async () => pasteboard.image
}))
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }))
vi.mock('./mobile-clipboard-image', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileClipboardImage>()),
  prepareMobileClipboardImageBase64: async () => 'png',
  saveMobileClipboardImageAsTempFile: async () => '/tmp/shot.png'
}))

function setup() {
  const sendRequest = vi.fn()
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
  const activeHandleRef = { current: 'term-1' }
  const connStateRef: { current: ConnectionState } = { current: 'connected' }
  const onError = vi.fn()
  const showToast = vi.fn()
  let beforeSend = (): boolean => true
  const options: Parameters<typeof useMobileTerminalPaste>[0] = {
    sendTerminalUserInput: terminalInputSend.request,
    agent: null,
    activeHandle: 'term-1',
    activeHandleRef,
    activeSessionTabTypeRef: { current: 'terminal' },
    canSend: true,
    client,
    clientRef: { current: client },
    connState: 'connected',
    connStateRef,
    deviceTokenRef: { current: null },
    flushPendingLiveInputBeforeExternalSend: async () => beforeSend(),
    getActiveWorktreeConnectionId: async () => null,
    onError,
    onSuccess: vi.fn(),
    ptyModesRef: { current: new Map() },
    refreshCanPaste: vi.fn(),
    showToast
  }
  return {
    options,
    client,
    sendRequest,
    onError,
    showToast,
    activeHandleRef,
    connStateRef,
    setBeforeSend: (fn: () => boolean) => {
      beforeSend = fn
    }
  }
}

describe('mobile terminal paste that sends nothing', () => {
  beforeEach(() => {
    pasteboard.image = { data: 'png' }
  })

  it('says so when the clipboard image read comes back empty', async () => {
    pasteboard.image = null
    const { options, sendRequest, onError, showToast } = setup()
    await useMobileTerminalPaste(options)()
    expect(sendRequest).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith("Couldn't read the clipboard", 1500)
  })

  it('says so when the connection drops while the image uploads', async () => {
    const { options, sendRequest, onError, showToast, connStateRef, setBeforeSend } = setup()
    setBeforeSend(() => {
      connStateRef.current = 'reconnecting'
      return false
    })
    await useMobileTerminalPaste(options)()
    expect(sendRequest).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Paste failed (disconnected)', 1500)
  })

  it('says so when the terminal changes while the image uploads', async () => {
    const { options, sendRequest, onError, showToast, activeHandleRef, setBeforeSend } = setup()
    setBeforeSend(() => {
      activeHandleRef.current = 'term-2'
      return false
    })
    await useMobileTerminalPaste(options)()
    expect(sendRequest).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Paste canceled (terminal changed)', 1500)
  })

  it('says so when typed input queued ahead of the paste fails to send', async () => {
    const { options, sendRequest, onError, showToast, setBeforeSend } = setup()
    setBeforeSend(() => false)
    await useMobileTerminalPaste(options)()
    expect(sendRequest).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Paste failed', 1500)
  })

  it.each(['open', 'send'])(
    'reports a real ordered sender %s failure instead of paste success',
    async (failure) => {
      const { options, client, sendRequest, onError, showToast } = setup()
      const sender = new MobileTerminalInputSender()
      sendRequest.mockImplementation(async (method: string) => {
        if (failure === 'send' && method === 'terminal.openInputSession') {
          return { id: 'open', ok: true, result: { inputSessionId: 'session' } }
        }
        throw new Error('link failed')
      })
      await useMobileTerminalPaste({
        ...options,
        deviceTokenRef: { current: 'phone' },
        sendTerminalUserInput: (_client, params, sendOptions) =>
          sender.request(client, params, sendOptions, true)
      })()
      expect(onError).toHaveBeenCalledOnce()
      expect(options.onSuccess).not.toHaveBeenCalled()
      expect(showToast).toHaveBeenCalledWith('Paste failed', 1500)
    }
  )
})
