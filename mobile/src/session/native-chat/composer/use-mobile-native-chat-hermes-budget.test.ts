import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc-client'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'

vi.mock('../../../platform/media-picker', () => ({
  useMediaPicker: () => ({ pickImages: vi.fn() })
}))
afterEach(() => vi.useRealTimers())

it('passes the Hermes startup budget through the composer to the text send', async () => {
  vi.useFakeTimers()
  const baseSend = vi.fn().mockResolvedValue('accepted')
  let send: ((text: string) => Promise<boolean>) | undefined
  function Probe() {
    const result = useMobileNativeChatImageAttachments({
      agent: 'hermes',
      // SAFETY: This text-only path does not call the client's methods.
      client: {} as RpcClient,
      activeHandleRef: { current: 'term-budget-test' },
      deviceTokenRef: { current: null },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      scopeKey: 'budget-test',
      enabled: true,
      structuredNativeChat: false,
      showToast: vi.fn(),
      onSendError: vi.fn(),
      baseSend,
      readSeededLaunchDraft: () => null,
      sleep: async () => {}
    })
    send = result.sendNativeChat
    return null
  }
  let renderer: ReturnType<typeof create> | undefined
  act(() => {
    renderer = create(createElement(Probe))
  })
  const pressedAt = Date.now()
  await act(async () => {
    await send!('hello')
  })
  expect(baseSend.mock.calls[0]?.[2]).toBe(pressedAt + 75_000)
  act(() => renderer?.unmount())
})
