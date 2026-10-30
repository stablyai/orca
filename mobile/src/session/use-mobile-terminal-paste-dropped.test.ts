import { terminalInputSend } from '../terminal/mobile-terminal-operations'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type * as MobileClipboardImage from './mobile-clipboard-image'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'

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
vi.mock('../terminal/worker-terminal-takeover-report', () => ({
  reportWorkerTerminalUserInput: vi.fn()
}))
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
})
