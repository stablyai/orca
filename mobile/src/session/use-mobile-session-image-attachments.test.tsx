import { createElement } from 'react'
import { resetMobileNativeChatDraftInputsForTests } from './native-chat/composer/mobile-native-chat-draft-inputs'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { resetMobileNativeChatStaleInputForTests } from './native-chat/mobile-native-chat-stale-input'
import { resetMobileNativeChatTerminalWritesForTests } from './native-chat/mobile-native-chat-terminal-write-lock'
import { useMobileSessionImageAttachments } from './use-mobile-session-image-attachments'

vi.mock('../platform/media-picker', () => ({
  useMediaPicker: () => ({
    pickImages: async function* () {
      yield { base64: 'AAAA', uri: 'file:///a.jpg' }
    }
  })
}))

type HookArgs = Parameters<typeof useMobileSessionImageAttachments>[0]
type Hook = ReturnType<typeof useMobileSessionImageAttachments>

function baseArgs(overrides: Partial<Omit<HookArgs, 'client'>> = {}) {
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method) => {
    if (method === 'clipboard.startImageUpload') {
      return { id: 'start', ok: false, error: { code: 'method_not_found', message: 'no' } }
    }
    if (method === 'clipboard.saveImageAsTempFile') {
      return { id: 'save', ok: true, result: '/tmp/a.png' }
    }
    if (method === 'terminal.send') {
      return { id: 'send', ok: true, result: { send: { accepted: true } } }
    }
    throw new Error(`unexpected request: ${method}`)
  })
  return {
    client,
    agent: 'claude',
    activeHandle: 'term-1',
    activeHandleRef: { current: 'term-1' },
    canSend: true,
    connState: 'connected',
    deviceTokenRef: { current: null },
    nativeChatScopeKey: 'scope-1',
    nativeChatInputLeaseReady: false,
    nativeChatAgentConfirmed: true,
    getActiveWorktreeConnectionId: async () => 'conn-1',
    beforeTerminalSend: async () => true,
    nativeChatBaseSend: vi.fn().mockResolvedValue('accepted'),
    structuredNativeChat: true,
    nativeChatSessionId: 'session-1',
    readSeededLaunchDraft: () => null,
    showToast: vi.fn(),
    onNativeChatSendError: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
    ...overrides
  } satisfies HookArgs
}

describe('useMobileSessionImageAttachments', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook

  function Harness({ args }: { args: HookArgs }): null {
    hook = useMobileSessionImageAttachments(args)
    return null
  }

  beforeEach(() => {
    resetMobileNativeChatDraftInputsForTests()
    vi.useFakeTimers()
    resetMobileNativeChatStaleInputForTests()
    resetMobileNativeChatTerminalWritesForTests()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  async function renderWithImage(args: HookArgs): Promise<void> {
    act(() => {
      renderer = create(createElement(Harness, { args }))
    })
    await act(async () => {
      await hook.nativeChatImages.attachImage('library')
    })
    expect(hook.nativeChatImages.attachments).toEqual([
      { id: expect.any(String), path: '/tmp/a.png', previewUri: 'file:///a.jpg' }
    ])
  }

  async function send(): Promise<boolean> {
    let accepted = false
    await act(async () => {
      const pending = hook.nativeChatImages.sendNativeChat('look')
      await vi.advanceTimersByTimeAsync(300)
      accepted = await pending
    })
    return accepted
  }

  it('sends structured session images without a terminal input lease', async () => {
    const args = baseArgs({ activeHandle: null, activeHandleRef: { current: null } })
    await renderWithImage(args)
    const image = hook.nativeChatImages.attachments[0]

    expect(await send()).toBe(true)
    expect(args.nativeChatBaseSend).toHaveBeenCalledWith(
      'look',
      ['file:///a.jpg'],
      expect.any(Number),
      [image]
    )
    expect(args.client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'clipboard.startImageUpload',
      'clipboard.saveImageAsTempFile'
    ])
    expect(hook.nativeChatImages.attachments).toEqual([])
  })

  it.each([false, true])('gates terminal image delivery on input lease %s', async (leaseReady) => {
    const args = baseArgs({
      nativeChatInputLeaseReady: leaseReady,
      structuredNativeChat: false
    })
    await renderWithImage(args)

    expect(await send()).toBe(leaseReady)
    const sends = args.client.sendRequest.mock.calls.filter(
      ([method]) => method === 'terminal.send'
    )
    if (leaseReady) {
      expect(sends).toEqual([
        ['terminal.send', { terminal: 'term-1', text: '\x15', enter: false }, expect.any(Object)],
        [
          'terminal.send',
          { terminal: 'term-1', text: '\x1b[200~/tmp/a.png\x1b[201~ ', enter: false },
          expect.any(Object)
        ]
      ])
      expect(args.nativeChatBaseSend).toHaveBeenCalledWith(
        'look',
        ['file:///a.jpg'],
        expect.any(Number),
        undefined,
        expect.any(Number)
      )
      expect(hook.nativeChatImages.attachments).toEqual([])
    } else {
      expect(sends).toEqual([])
      expect(args.nativeChatBaseSend).not.toHaveBeenCalled()
      expect(args.onNativeChatSendError).toHaveBeenCalledWith('Message not sent (disconnected)')
      expect(hook.nativeChatImages.attachments).toHaveLength(1)
    }
  })

  it('keeps a structured session image pending when the connection drops', async () => {
    const args = baseArgs()
    await renderWithImage(args)
    act(() => {
      renderer?.update(createElement(Harness, { args: { ...args, connState: 'connecting' } }))
    })

    expect(await send()).toBe(false)
    expect(args.nativeChatBaseSend).not.toHaveBeenCalled()
    expect(args.onNativeChatSendError).toHaveBeenCalledWith('Message not sent (disconnected)')
    expect(hook.nativeChatImages.attachments).toHaveLength(1)
    expect(args.client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'clipboard.startImageUpload',
      'clipboard.saveImageAsTempFile'
    ])
  })

  it('keeps a terminal image pending until the live agent is confirmed', async () => {
    const args = baseArgs({
      nativeChatInputLeaseReady: true,
      nativeChatAgentConfirmed: false,
      structuredNativeChat: false
    })
    await renderWithImage(args)

    expect(await send()).toBe(false)
    expect(args.nativeChatBaseSend).not.toHaveBeenCalled()
    expect(args.onNativeChatSendError).toHaveBeenCalledWith('Message not sent (disconnected)')
    expect(hook.nativeChatImages.attachments).toHaveLength(1)
    expect(args.client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'clipboard.startImageUpload',
      'clipboard.saveImageAsTempFile'
    ])
  })
})
