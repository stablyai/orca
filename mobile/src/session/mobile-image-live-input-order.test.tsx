import { terminalInputSend } from '../terminal/mobile-terminal-operations'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { TerminalLiveInputSender } from '../terminal/terminal-live-input-sender'
import { useTerminalLiveInputCommit } from '../terminal/use-terminal-live-input-commit'
import { attachMobileImageToTerminal } from './mobile-image-attachment'
import { resolveMobileImageAttachmentAgent } from './mobile-image-paste-agent'
import { useMobileAttachmentInputLeaseGate } from './use-mobile-attachment-input-lease-gate'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'

vi.mock('react-native', () => ({ Keyboard: { dismiss: vi.fn() } }))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn() }))
vi.mock('expo-clipboard', () => ({
  getStringAsync: async () => '',
  getImageAsync: async () => ({ data: 'AAAA', size: { width: 1, height: 1 } })
}))
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }))

const ref = <T,>(current: T) => ({ current })
const renderers: ReactTestRenderer[] = []
const imagePayload = '\x1b[200~/tmp/orca-image.png\x1b[201~ '

function fixture(title = 'Terminal', imagePath = '/tmp/orca-image.png', launchAgent?: TuiAgent) {
  const agent = resolveMobileImageAttachmentAgent(
    { type: 'terminal', id: 'tab-1', title, terminal: 'term-1', isActive: true, launchAgent },
    null
  )
  const sends: Array<{ terminal: unknown; text: unknown; enter: unknown }> = []
  let resolveText!: (value: RpcResponse) => void
  let textStarted!: () => void
  const started = new Promise<void>((resolve) => {
    textStarted = resolve
  })
  const ok = (result: unknown): RpcResponse => ({ id: 'rpc', ok: true, result })
  const client: RpcClient = {
    sendRequest: vi.fn(async (method, params) => {
      if (method === 'clipboard.startImageUpload') {
        return ok({ uploadId: 'upload' })
      }
      if (method === 'clipboard.appendImageUploadChunk') {
        return ok({ receivedBase64Length: 4 })
      }
      if (method === 'clipboard.commitImageUpload') {
        return ok(imagePath)
      }
      if (method === 'terminal.send') {
        if (!params || typeof params !== 'object' || !('text' in params)) {
          throw new Error('terminal send requires text')
        }
        if (!('terminal' in params) || !('enter' in params)) {
          throw new Error('terminal send requires target and enter')
        }
        sends.push({ terminal: params.terminal, text: params.text, enter: params.enter })
        if (params.text === '한글') {
          textStarted()
          return new Promise<RpcResponse>((resolve) => {
            resolveText = resolve
          })
        }
        return ok({ send: { accepted: true } })
      }
      throw new Error(`unexpected request: ${method}`)
    }),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
  const activeHandleRef = ref<string | null>('term-1')
  const activeSessionTabTypeRef = ref<string | null>('terminal')
  const liveInputRef = ref(null)
  const sendLiveTerminalInputRef = ref<TerminalLiveInputSender>(async () => false)
  const scope = {
    sendTerminalUserInput: terminalInputSend.request,
    client,
    clientRef: ref(client),
    activeHandle: 'term-1',
    activeHandleRef,
    activeSessionTabTypeRef,
    connState: 'connected' as const,
    connStateRef: ref('connected' as const),
    canSend: true,
    deviceTokenRef: ref('phone'),
    ptyModesRef: ref(new Map()),
    liveInputRef,
    commandInputRef: ref(null),
    liveInputFocusTimerRef: ref(null),
    sendLiveTerminalInputRef,
    showToast: vi.fn()
  }
  let live!: ReturnType<typeof useTerminalLiveInputCommit>
  let paste!: ReturnType<typeof useMobileTerminalPaste>
  let beforeTerminalSend!: (target: string) => Promise<boolean>
  function Harness() {
    live = useTerminalLiveInputCommit({
      activeHandle: 'term-1',
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef,
      connected: true,
      liveInputRef,
      liveInputTerminalHandles: new Set(['term-1']),
      liveInputTerminalHandlesRef: ref(new Set(['term-1'])),
      sendLiveTerminalInputRef,
      setLiveInputCapture: vi.fn()
    })
    useMobileSessionTerminalSendActions(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: live sending reads the supplied refs; unrelated action-sheet and buffered-submit callbacks are not invoked.
      scope as unknown as Parameters<typeof useMobileSessionTerminalSendActions>[0]
    )
    beforeTerminalSend = useMobileAttachmentInputLeaseGate({
      ...scope,
      flushPendingLiveInputBeforeExternalSend: live.flushPendingLiveInputBeforeExternalSend,
      nativeChatInputLeaseReadyRef: ref(true)
    })
    paste = useMobileTerminalPaste({
      ...scope,
      agent,
      flushPendingLiveInputBeforeExternalSend: live.flushPendingLiveInputBeforeExternalSend,
      getActiveWorktreeConnectionId: async () => null,
      onError: vi.fn(),
      onSuccess: vi.fn(),
      ptyModesRef: ref(new Map()),
      refreshCanPaste: vi.fn()
    })
    return null
  }
  act(() => {
    renderers.push(create(createElement(Harness)))
  })
  return {
    sends,
    started,
    activeHandleRef,
    change: (text: string) => live.handleLiveInputChange({ nativeEvent: { text } }),
    flush: () => live.flushPendingLiveInputBeforeExternalSend('term-1'),
    acceptText: (accepted: boolean) => resolveText(ok({ send: { accepted } })),
    attach: (entry: 'picker' | 'clipboard') =>
      entry === 'clipboard'
        ? paste()
        : attachMobileImageToTerminal('library', {
            client,
            terminal: 'term-1',
            deviceToken: 'phone',
            agent,
            pickImage: async () => ({ base64: 'AAAA' }),
            getConnectionId: async () => null,
            beforeTerminalSend
          })
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount()
    }
  })
  vi.useRealTimers()
})

it.each(['picker', 'clipboard'] as const)(
  '%s waits for composed text acknowledgement and starts a fresh mirror after the image',
  async (entry) => {
    const test = fixture()
    for (const text of ['ㅎ', '하', '한', '한ㄱ', '한그', '한글']) {
      test.change(text)
    }
    expect(test.sends).toEqual([])
    const attachment = test.attach(entry)
    await test.started
    expect(test.sends).toEqual([{ terminal: 'term-1', text: '한글', enter: false }])
    test.acceptText(true)
    await attachment
    test.change('next')
    await test.flush()
    expect(test.sends).toEqual([
      { terminal: 'term-1', text: '한글', enter: false },
      { terminal: 'term-1', text: imagePayload, enter: false },
      { terminal: 'term-1', text: 'next', enter: false }
    ])
    await vi.advanceTimersByTimeAsync(1000)
    expect(test.sends).toHaveLength(3)
  }
)

it.each(['picker', 'clipboard'] as const)(
  '%s suppresses the image when the real live sender refuses the pending text',
  async (entry) => {
    const test = fixture()
    test.change('한글')
    const attachment = test.attach(entry)
    await test.started
    test.acceptText(false)
    await attachment
    expect(test.sends).toEqual([{ terminal: 'term-1', text: '한글', enter: false }])
  }
)

it.each(['picker', 'clipboard'] as const)(
  '%s suppresses the image if the target changes while the real live send is pending',
  async (entry) => {
    const test = fixture()
    test.change('한글')
    const attachment = test.attach(entry)
    await test.started
    test.activeHandleRef.current = 'term-2'
    test.acceptText(true)
    await attachment
    expect(test.sends).toEqual([{ terminal: 'term-1', text: '한글', enter: false }])
  }
)

it.each(['picker', 'clipboard'] as const)(
  '%s keeps anonymous image attachment bytes when the terminal display title names another agent',
  async (entry) => {
    const test = fixture('OpenCode')
    await test.attach(entry)
    expect(test.sends).toEqual([{ terminal: 'term-1', text: imagePayload, enter: false }])
  }
)

it.each([
  ['picker', undefined],
  ['clipboard', undefined],
  ['picker', 'codex'],
  ['clipboard', 'codex']
] as const)('%s escapes a spaced host temp path with agent %s', async (entry, launchAgent) => {
  const test = fixture('Terminal', '/tmp/orca images/orca.png', launchAgent)
  await test.attach(entry)
  expect(test.sends).toEqual([
    { terminal: 'term-1', text: '\x1b[200~/tmp/orca\\ images/orca.png\x1b[201~ ', enter: false }
  ])
})
