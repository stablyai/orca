import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { TerminalModes } from '../terminal/terminal-webview-contract'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'

// `useMemo` joins `useCallback` because the paste now reads the clipboard through the platform
// seam, which is a hook. Called rather than cached: this test mounts nothing, so there is no
// render to hold a value across.
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory()
}))
// The clipboard seam's native half is what the hook calls, so the pasteboard is what a test stands
// in for: text, image and the two probes behind `contents`.
const clipboardText = vi.hoisted(() => ({ current: '' }))
vi.mock('expo-clipboard', () => ({
  getStringAsync: async () => clipboardText.current,
  getImageAsync: async () => ({ data: 'png' })
}))
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }))
vi.mock('../terminal/worker-terminal-takeover-report', () => ({
  reportWorkerTerminalUserInput: vi.fn()
}))
vi.mock('./mobile-clipboard-image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-clipboard-image')>()),
  prepareMobileClipboardImageBase64: async () => 'png',
  saveMobileClipboardImageAsTempFile: async () => '/tmp/shot.png'
}))

function usePasteUnderTest(agent: string, modes?: TerminalModes) {
  const sendRequest = vi.fn().mockResolvedValue({ ok: true, result: { send: { accepted: true } } })
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
    ptyModesRef: { current: new Map(modes ? [['term-1', modes]] : []) },
    refreshCanPaste: vi.fn(),
    showToast: vi.fn()
  })
  return { paste, sendRequest }
}

const modes = (overrides: Partial<TerminalModes>): TerminalModes => ({
  bracketedPasteMode: false,
  altScreen: false,
  mouseTrackingMode: 'none',
  sgrMouseMode: false,
  sgrMousePixelsMode: false,
  ...overrides
})

describe('mobile clipboard image followed by typing', () => {
  it.each(['omp', 'claude', 'codex', null, 'unknown'])(
    'separates a pasted image from subsequent %s input',
    async (agent) => {
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
    }
  )

  it.each(['terminal switch', 'non-terminal view', 'disconnect'])(
    'drops a completed image paste after a pending input flush observes %s',
    async (change) => {
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
      const activeSessionTabTypeRef = { current: 'terminal' }
      const connStateRef: { current: ConnectionState } = { current: 'connected' }
      let releaseFlush!: (ready: boolean) => void
      let flushStarted!: () => void
      const flushing = new Promise<void>((resolve) => {
        flushStarted = resolve
      })
      const onSuccess = vi.fn()
      const paste = useMobileTerminalPaste({
        agent: null,
        activeHandle: 'term-1',
        activeHandleRef,
        activeSessionTabTypeRef,
        canSend: true,
        client,
        clientRef: { current: client },
        connState: 'connected',
        connStateRef,
        deviceTokenRef: { current: null },
        flushPendingLiveInputBeforeExternalSend: () => {
          flushStarted()
          return new Promise<boolean>((resolve) => {
            releaseFlush = resolve
          })
        },
        getActiveWorktreeConnectionId: async () => null,
        onError: vi.fn(),
        onSuccess,
        ptyModesRef: { current: new Map() },
        refreshCanPaste: vi.fn(),
        showToast: vi.fn()
      })
      const pending = paste()
      await flushing
      if (change === 'terminal switch') {
        activeHandleRef.current = 'term-2'
      }
      if (change === 'non-terminal view') {
        activeSessionTabTypeRef.current = 'agent-session'
      }
      if (change === 'disconnect') {
        connStateRef.current = 'disconnected'
      }
      releaseFlush(true)
      await pending
      expect(sendRequest).not.toHaveBeenCalled()
      expect(onSuccess).not.toHaveBeenCalled()
    }
  )
})

describe('mobile clipboard text paste', () => {
  const paragraph = 'This sentence is filler text that mimics ordinary dictated prose. '.repeat(8)
  const longText = [paragraph, paragraph, paragraph, paragraph].join('\n\n')

  // #13332: Claude enables bracketed paste on the alternate screen; sent unframed, it kept
  // only the final ~1 KiB piece of a long paste.
  it('frames a long multi-paragraph paste on the alternate screen', async () => {
    clipboardText.current = longText
    const { paste, sendRequest } = usePasteUnderTest(
      'claude',
      modes({ bracketedPasteMode: true, altScreen: true })
    )
    await paste()
    expect(sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term-1',
      text: `\x1b[200~${longText.replace(/\n/g, '\r')}\x1b[201~`,
      enter: false
    })
  })

  it.each([
    ['claude', modes({}), 'a\nb'],
    ['claude', undefined, 'a\nb'],
    ['claude', modes({ bracketedPasteMode: true }), '\x1b[200~a\rb\x1b[201~'],
    ['codex', modes({ bracketedPasteMode: true, altScreen: true }), 'a\nb'],
    ['codex', modes({ bracketedPasteMode: true }), '\x1b[200~a\rb\x1b[201~']
  ])('preserves %s paste protocol with modes %j', async (agent, terminalModes, expected) => {
    clipboardText.current = 'a\nb'
    const { paste, sendRequest } = usePasteUnderTest(agent, terminalModes)
    await paste()
    expect(sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term-1',
      text: expected,
      enter: false
    })
  })

  it('neutralizes embedded frame terminators through the clipboard path', async () => {
    clipboardText.current = 'safe\x1b[201~echo unsafe'
    const { paste, sendRequest } = usePasteUnderTest('claude', modes({ bracketedPasteMode: true }))
    await paste()
    expect(sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term-1',
      text: '\x1b[200~safe␛[201~echo unsafe\x1b[201~',
      enter: false
    })
  })
})
