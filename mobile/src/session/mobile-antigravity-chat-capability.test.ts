import { expect, it, vi } from 'vitest'
import {
  requireMobileAntigravityChatCapability,
  startMobileNativeChatAfterCapability
} from './mobile-antigravity-chat-capability'

const response = (capabilities: string[]) => ({
  ok: true as const,
  id: 'status',
  result: { capabilities },
  _meta: { runtimeId: 'host' }
})

it('refuses old hosts and keeps transient probe failures as read errors', async () => {
  await expect(
    requireMobileAntigravityChatCapability(
      { sendRequest: vi.fn(async () => response([])) },
      'antigravity'
    )
  ).rejects.toThrow('Update the connected')
  await expect(
    requireMobileAntigravityChatCapability(
      {
        sendRequest: vi.fn(async () => {
          throw new Error('timeout')
        })
      },
      'antigravity'
    )
  ).rejects.toThrow('Unable to read')
})

it('does not open a cancelled subscription after a capability probe settles', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof response>>()
  const start = vi.fn(() => () => {})
  const onError = vi.fn()
  const cancel = startMobileNativeChatAfterCapability(
    { sendRequest: () => pending.promise },
    'antigravity',
    start,
    onError
  )
  cancel()
  pending.resolve(response(['native-chat.antigravity.v1']))
  await vi.waitFor(() => expect(pending.promise).resolves.toBeDefined())
  expect(start).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
})

it('opens capable hosts and tears down their stream', async () => {
  const stop = vi.fn()
  const start = vi.fn(() => stop)
  const cancel = startMobileNativeChatAfterCapability(
    { sendRequest: vi.fn(async () => response(['native-chat.antigravity.v1'])) },
    'antigravity',
    start,
    vi.fn()
  )
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
  cancel()
  expect(stop).toHaveBeenCalledOnce()
})
