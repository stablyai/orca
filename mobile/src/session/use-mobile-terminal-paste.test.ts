import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'

vi.mock('react', () => ({ useCallback: (callback: unknown) => callback }))
vi.mock('expo-clipboard', () => ({
  getStringAsync: async () => '',
  getImageAsync: async () => ({ data: 'png' })
}))
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }))
vi.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: {} }))
vi.mock('../terminal/worker-terminal-takeover-report', () => ({
  reportWorkerTerminalUserInput: vi.fn()
}))
vi.mock('./mobile-clipboard-image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-clipboard-image')>()),
  prepareMobileClipboardImageBase64: async () => 'png',
  saveMobileClipboardImageAsTempFile: async () => '/tmp/shot.png'
}))

describe('mobile clipboard image followed by typing', () => {
  it.each(['omp', 'claude'])('separates a pasted image from subsequent %s input', async (agent) => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { send: { accepted: true } } })
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
    const paste = useMobileTerminalPaste({
      agent,
      activeHandle: 'term-1',
      activeHandleRef: { current: 'term-1' },
      activeSessionTabTypeRef: { current: 'terminal' },
      canSend: true,
      client,
      clientRef: { current: client },
      connState: 'connected',
      connStateRef: { current: 'connected' },
      deviceTokenRef: { current: null },
      flushPendingLiveInputBeforeExternalSend: async () => true,
      getActiveWorktreeConnectionId: async () => null,
      onError: vi.fn(),
      onSuccess: vi.fn(),
      ptyModesRef: { current: new Map() },
      refreshCanPaste: vi.fn(),
      showToast: vi.fn()
    })
    await paste()
    expect(sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term-1',
      text: `\x1b[200~${agent === 'omp' ? '@' : ''}/tmp/shot.png\x1b[201~ `,
      enter: false
    })
  })
})
