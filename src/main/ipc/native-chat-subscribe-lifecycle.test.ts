import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, listeners, subscribeTranscript } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listeners: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  subscribeTranscript: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      listeners.set(channel, handler)
    })
  }
}))

vi.mock('../native-chat/transcript-watch', () => ({
  subscribeNativeChatTranscript: subscribeTranscript
}))

import {
  _getNativeChatPendingSubscriptionCountForTest,
  _getNativeChatSenderCleanupCountForTest,
  clearNativeChatSubscriptions,
  registerNativeChatHandlers
} from './native-chat'

type TestSubscription = {
  unsubscribe: ReturnType<typeof vi.fn>
  watching: boolean
}

type DeferredSubscription = {
  promise: Promise<TestSubscription>
  reject: (error: Error) => void
  resolve: () => void
  unsubscribe: ReturnType<typeof vi.fn>
}

type SenderHarness = {
  destroy: () => void
  registeredCleanupCount: () => number
  sender: {
    id: number
    isDestroyed: () => boolean
    once: (event: string, callback: () => void) => void
    send: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  clearNativeChatSubscriptions()
  handlers.clear()
  listeners.clear()
  subscribeTranscript.mockReset()
  registerNativeChatHandlers()
})

function deferredSubscription(): DeferredSubscription {
  const unsubscribe = vi.fn()
  let resolvePromise: (subscription: TestSubscription) => void = () => {}
  let rejectPromise: (error: Error) => void = () => {}
  const promise = new Promise<TestSubscription>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    reject: rejectPromise,
    resolve: () => resolvePromise({ unsubscribe, watching: true }),
    unsubscribe
  }
}

function createSender(id: number): SenderHarness {
  let destroyed = false
  const destroyedCallbacks: (() => void)[] = []
  return {
    destroy: () => {
      destroyed = true
      for (const callback of destroyedCallbacks) {
        callback()
      }
    },
    registeredCleanupCount: () => destroyedCallbacks.length,
    sender: {
      id,
      isDestroyed: () => destroyed,
      once: (event, callback) => {
        if (event === 'destroyed') {
          destroyedCallbacks.push(callback)
        }
      },
      send: vi.fn()
    }
  }
}

function subscribe(sender: SenderHarness['sender'], subscriptionId: string): void {
  const listener = listeners.get('nativeChat:subscribe')
  if (!listener) {
    throw new Error('subscribe listener not registered')
  }
  listener({ sender }, { subscriptionId, agent: 'claude', sessionId: `session-${subscriptionId}` })
}

type InitialSnapshotCallback = (
  messages: unknown[],
  hasMore: boolean,
  beforeOffset: number,
  error?: string
) => void

// The onInitialSnapshot callback the handler passed into the Nth subscribeTranscript
// call; transcript-watch fires it during setup, so tests invoke it directly.
function initialSnapshot(callIndex: number): InitialSnapshotCallback {
  const call = subscribeTranscript.mock.calls[callIndex]
  if (!call) {
    throw new Error('subscribeTranscript was not called')
  }
  return (call[0] as { onInitialSnapshot: InitialSnapshotCallback }).onInitialSnapshot
}

function unsubscribe(sender: SenderHarness['sender'], subscriptionId: string): void {
  const listener = listeners.get('nativeChat:unsubscribe')
  if (!listener) {
    throw new Error('unsubscribe listener not registered')
  }
  listener({ sender }, { subscriptionId })
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for lifecycle state')
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('nativeChat subscribe lifecycle', () => {
  it('closes a watcher that resolves after renderer unsubscribe', async () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(1)

    subscribe(renderer.sender, 'unmount')
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(1)
    unsubscribe(renderer.sender, 'unmount')
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(0)
    unsubscribe(renderer.sender, 'unmount')
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(0)

    pending.resolve()
    await waitFor(() => pending.unsubscribe.mock.calls.length === 1)
    unsubscribe(renderer.sender, 'unmount')
    expect(pending.unsubscribe).toHaveBeenCalledOnce()
    renderer.destroy()
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)
  })

  it('closes a watcher that resolves after renderer destruction', async () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(2)

    subscribe(renderer.sender, 'destroy')
    renderer.destroy()
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(0)
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)

    pending.resolve()
    await waitFor(() => pending.unsubscribe.mock.calls.length === 1)
  })

  it('keeps the latest same-id subscribe when setup resolves in reverse order', async () => {
    const older = deferredSubscription()
    const newer = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const renderer = createSender(3)

    subscribe(renderer.sender, 'same-id')
    subscribe(renderer.sender, 'same-id')
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(1)

    newer.resolve()
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)
    expect(newer.unsubscribe).not.toHaveBeenCalled()
    older.resolve()
    await waitFor(() => older.unsubscribe.mock.calls.length === 1)

    unsubscribe(renderer.sender, 'same-id')
    expect(newer.unsubscribe).toHaveBeenCalledOnce()
    renderer.destroy()
  })

  it('clears rejected setup without duplicating sender cleanup registration', async () => {
    const failed = deferredSubscription()
    const retry = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise)
    const renderer = createSender(4)

    subscribe(renderer.sender, 'retry')
    failed.reject(new Error('watch setup failed'))
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(1)

    subscribe(renderer.sender, 'retry')
    expect(renderer.registeredCleanupCount()).toBe(1)
    retry.resolve()
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)
    unsubscribe(renderer.sender, 'retry')
    expect(retry.unsubscribe).toHaveBeenCalledOnce()
    renderer.destroy()
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)
  })

  it('isolates late setup from a replacement renderer reusing the sender id', async () => {
    const oldPending = deferredSubscription()
    const replacementPending = deferredSubscription()
    subscribeTranscript
      .mockReturnValueOnce(oldPending.promise)
      .mockReturnValueOnce(replacementPending.promise)
    const oldRenderer = createSender(41)
    const replacementRenderer = createSender(41)

    subscribe(oldRenderer.sender, 'remount')
    oldRenderer.destroy()
    subscribe(replacementRenderer.sender, 'remount')
    expect(replacementRenderer.registeredCleanupCount()).toBe(1)

    replacementPending.resolve()
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)
    oldPending.resolve()
    await waitFor(() => oldPending.unsubscribe.mock.calls.length === 1)
    expect(replacementPending.unsubscribe).not.toHaveBeenCalled()

    replacementRenderer.destroy()
    expect(replacementPending.unsubscribe).toHaveBeenCalledOnce()
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)
  })

  it('forwards an initial-drain error onto the snapshot frame', () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(5)

    subscribe(renderer.sender, 'drain-error')
    // transcript-watch delivers the drain error synchronously via onInitialSnapshot;
    // invoke the captured callback to exercise the handler's forwarding closure.
    initialSnapshot(0)([], false, 0, 'Transcript unavailable')

    expect(renderer.sender.send).toHaveBeenCalledWith('nativeChat:appended', {
      subscriptionId: 'drain-error',
      frame: {
        type: 'snapshot',
        messages: [],
        hasMore: false,
        error: 'Transcript unavailable'
      }
    })
  })

  it('omits error from the snapshot frame on a clean initial drain', () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(6)

    subscribe(renderer.sender, 'drain-clean')
    initialSnapshot(0)([], false, 0)

    expect(renderer.sender.send).toHaveBeenCalledWith('nativeChat:appended', {
      subscriptionId: 'drain-clean',
      frame: { type: 'snapshot', messages: [], hasMore: false }
    })
  })
})
