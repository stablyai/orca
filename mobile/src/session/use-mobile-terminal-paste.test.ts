import { terminalInputSend } from '../terminal/mobile-terminal-operations'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

import { useMobileTerminalPaste } from './use-mobile-terminal-paste'

// Call memo factories directly: this hook-only harness has no mounted render to cache across.
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory()
}))
const clipboard = vi.hoisted(() => ({ text: '' }))
vi.mock('expo-clipboard', () => ({
  getStringAsync: async () => clipboard.text,
  getImageAsync: async () => ({ data: 'png' })
}))
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }))
vi.mock('./mobile-clipboard-image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-clipboard-image')>()),
  prepareMobileClipboardImageBase64: async () => 'png',
  saveMobileClipboardImageAsTempFile: async () => '/tmp/shot.png'
}))

describe('mobile clipboard text paste', () => {
  it('frames a multi-line paste in an alt-screen app the way desktop does', async () => {
    clipboard.text = 'line 1\nline 2 \x1b[201~'
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
      sendTerminalUserInput: terminalInputSend.request,
      agent: null,
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
      ptyModesRef: {
        current: new Map([
          [
            'term-1',
            {
              bracketedPasteMode: true,
              altScreen: true,
              mouseTrackingMode: 'none',
              sgrMouseMode: false,
              sgrMousePixelsMode: false,
              applicationCursorKeysMode: false,
              kittyKeyboardFlags: 0,
              modifyOtherKeys: 0
            }
          ]
        ])
      },
      refreshCanPaste: vi.fn(),
      showToast: vi.fn()
    })
    try {
      await paste()
    } finally {
      clipboard.text = ''
    }
    expect(sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term-1',
      text: '\x1b[200~line 1\rline 2 \u241b[201~\x1b[201~',
      enter: false
    })
  })
})
