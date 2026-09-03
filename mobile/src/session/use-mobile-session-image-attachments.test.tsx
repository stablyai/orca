import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileSessionImageAttachments } from './use-mobile-session-image-attachments'

const mocks = vi.hoisted(() => ({
  useMobileImageAttachment: vi.fn(),
  useMobileNativeChatImageAttachments: vi.fn()
}))

vi.mock('./use-mobile-image-attachment', () => ({
  useMobileImageAttachment: mocks.useMobileImageAttachment
}))

vi.mock('./use-mobile-native-chat-image-attachments', () => ({
  useMobileNativeChatImageAttachments: mocks.useMobileNativeChatImageAttachments
}))

type HookArgs = Parameters<typeof useMobileSessionImageAttachments>[0]

function baseArgs(overrides: Partial<HookArgs> = {}): HookArgs {
  return {
    client: {} as RpcClient,
    activeHandle: 'term-1',
    activeHandleRef: { current: null },
    canSend: true,
    connState: 'connected',
    deviceTokenRef: { current: null },
    nativeChatScopeKey: 'scope-1',
    nativeChatInputLeaseReady: false,
    getActiveWorktreeConnectionId: async () => 'conn-1',
    beforeTerminalSend: async () => true,
    nativeChatBaseSend: vi.fn().mockResolvedValue('accepted'),
    structuredNativeChat: true,
    readSeededLaunchDraft: () => null,
    showToast: vi.fn(),
    onNativeChatSendError: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
    ...overrides
  }
}

describe('useMobileSessionImageAttachments', () => {
  let renderer: ReactTestRenderer | null = null

  function Harness({ args }: { args: HookArgs }): null {
    useMobileSessionImageAttachments(args)
    return null
  }

  beforeEach(() => {
    mocks.useMobileImageAttachment.mockReturnValue({
      attachImage: vi.fn(),
      isAttaching: false
    })
    mocks.useMobileNativeChatImageAttachments.mockReturnValue({
      attachments: [],
      isAttaching: false,
      attachImage: vi.fn(),
      removeAttachment: vi.fn(),
      sendNativeChat: vi.fn()
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  function render(args: HookArgs): void {
    act(() => {
      renderer = create(createElement(Harness, { args }))
    })
  }

  it('enables native-chat image sends for connected structured sessions without a terminal lease', () => {
    render(baseArgs())

    expect(mocks.useMobileNativeChatImageAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        structuredNativeChat: true
      })
    )
  })

  it('keeps terminal-backed native-chat image sends gated on the input lease', () => {
    render(
      baseArgs({
        activeHandleRef: { current: 'term-1' },
        nativeChatInputLeaseReady: false,
        structuredNativeChat: false
      })
    )

    expect(mocks.useMobileNativeChatImageAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        structuredNativeChat: false
      })
    )
  })

  it('disables structured native-chat image sends while disconnected', () => {
    render(
      baseArgs({
        connState: 'connecting',
        nativeChatInputLeaseReady: true,
        structuredNativeChat: true
      })
    )

    expect(mocks.useMobileNativeChatImageAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        structuredNativeChat: true
      })
    )
  })
})
