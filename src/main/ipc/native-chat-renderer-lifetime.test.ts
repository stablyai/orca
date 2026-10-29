import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from '../native-chat/transcript-watch-contract'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, args: unknown) => void>(),
  subscribe:
    vi.fn<
      (
        args: SubscribeNativeChatTranscriptArgs,
        signal?: AbortSignal
      ) => Promise<NativeChatTranscriptSubscription>
    >()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, listener: (event: unknown, args: unknown) => void) => {
      mocks.listeners.set(channel, listener)
    }
  }
}))
vi.mock('../native-chat/transcript-watch', () => ({
  subscribeNativeChatTranscript: mocks.subscribe
}))
vi.mock('../native-chat/transcript-read-cache', () => ({ clearNativeChatTranscriptCache: vi.fn() }))

import {
  _getNativeChatPendingSubscriptionCountForTest,
  _getNativeChatSenderCleanupCountForTest,
  clearNativeChatSubscriptions,
  registerNativeChatHandlers
} from './native-chat'

class Sender extends EventEmitter {
  send = vi.fn()
  isDestroyed = (): boolean => false
  constructor(readonly id: number) {
    super()
  }
}

const live = new Set<SubscribeNativeChatTranscriptArgs>()
const goneEvents = ['did-navigate', 'render-process-gone', 'destroyed'] as const

function subscribe(sender: Sender, subscriptionId: string): void {
  mocks.listeners.get('nativeChat:subscribe')?.(
    { sender },
    { subscriptionId, agent: 'claude', sessionId: 'one-agent-session' }
  )
}

function emitAppend(): void {
  for (const args of live) {
    args.onAppend([])
  }
}

function pendingSetup() {
  let resolve: (subscription: NativeChatTranscriptSubscription) => void = () => {}
  const promise = new Promise<NativeChatTranscriptSubscription>((settle) => {
    resolve = settle
  })
  const unsubscribe = vi.fn()
  return { promise, resolve: () => resolve({ watching: true, unsubscribe }), unsubscribe }
}

beforeEach(() => {
  clearNativeChatSubscriptions()
  live.clear()
  mocks.subscribe.mockReset().mockImplementation(async (args) => {
    live.add(args)
    return { watching: true, unsubscribe: () => void live.delete(args) }
  })
  registerNativeChatHandlers()
})

afterEach(() => {
  clearNativeChatSubscriptions()
})

it.each(goneEvents)('releases every live viewer subscription after %s', async (event) => {
  const sender = new Sender(1)
  subscribe(sender, 'pane-a')
  subscribe(sender, 'pane-b')
  await Promise.resolve()
  expect(live.size).toBe(2)
  emitAppend()
  expect(sender.send).toHaveBeenCalledTimes(2)

  sender.emit(event)
  expect(live.size).toBe(0)
  expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)
  emitAppend()
  expect(sender.send).toHaveBeenCalledTimes(2)
  for (const gone of goneEvents) {
    expect(sender.listenerCount(gone)).toBe(0)
  }
})

it.each(goneEvents)('aborts pending setup and closes a late watcher after %s', async (event) => {
  const pending = pendingSetup()
  mocks.subscribe.mockReturnValueOnce(pending.promise)
  const sender = new Sender(2)
  subscribe(sender, 'pending')
  const signal = mocks.subscribe.mock.calls[0]?.[1]
  expect(signal?.aborted).toBe(false)

  sender.emit(event)
  expect(signal?.aborted).toBe(true)
  expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(0)
  pending.resolve()
  await Promise.resolve()
  expect(pending.unsubscribe).toHaveBeenCalledOnce()
})

it('does not publish callbacks from a replaced document into its replacement', async () => {
  const pending = pendingSetup()
  mocks.subscribe.mockReturnValueOnce(pending.promise)
  const sender = new Sender(3)
  subscribe(sender, 'same-id')
  const oldArgs = mocks.subscribe.mock.calls[0]?.[0]
  if (!oldArgs) {
    throw new Error('Subscription was not started')
  }
  sender.emit('did-navigate')
  subscribe(sender, 'same-id')
  await Promise.resolve()
  oldArgs.onTranscriptPending?.()
  oldArgs.onInitialSnapshot?.([], false, 0)
  oldArgs.onReplace?.([], false, 0)
  oldArgs.onAppend([])
  expect(sender.send).not.toHaveBeenCalled()
  pending.resolve()
  await Promise.resolve()
  expect(pending.unsubscribe).toHaveBeenCalledOnce()
  emitAppend()
  expect(sender.send).toHaveBeenCalledOnce()
})

it('retains only the current watcher after repeated reloads', async () => {
  const sender = new Sender(4)
  for (let cycle = 0; cycle < 15; cycle++) {
    subscribe(sender, `old-${cycle}`)
    await Promise.resolve()
    sender.emit('did-navigate')
  }
  subscribe(sender, 'current')
  await Promise.resolve()
  expect(live.size).toBe(1)
  emitAppend()
  expect(sender.send).toHaveBeenCalledOnce()
  for (const event of goneEvents) {
    expect(sender.listenerCount(event)).toBe(1)
  }
})

it('preserves another viewer of the same agent session when one renderer reloads', async () => {
  const first = new Sender(5)
  const second = new Sender(6)
  subscribe(first, 'shared-session')
  subscribe(second, 'shared-session')
  await Promise.resolve()
  first.emit('did-navigate')
  emitAppend()
  expect(live.size).toBe(1)
  expect(first.send).not.toHaveBeenCalled()
  expect(second.send).toHaveBeenCalledOnce()
})

it('preserves subscriptions through same-document and prevented navigation', async () => {
  const sender = new Sender(7)
  subscribe(sender, 'current')
  await Promise.resolve()
  sender.emit('did-start-navigation')
  sender.emit('did-navigate-in-page')
  emitAppend()
  expect(live.size).toBe(1)
  expect(sender.send).toHaveBeenCalledOnce()
})
