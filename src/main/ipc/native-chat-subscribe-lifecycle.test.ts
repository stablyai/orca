import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatTurnLifecycle } from '../../shared/native-chat-types'

const { handlers, listeners, readTranscriptTail, subscribeTranscript } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listeners: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  readTranscriptTail: vi.fn(),
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
  readNativeChatTranscriptTail: readTranscriptTail,
  subscribeNativeChatTranscript: subscribeTranscript
}))

import {
  _getNativeChatLiveSubscriptionCountForTest,
  _getNativeChatPendingSubscriptionCountForTest,
  _getNativeChatReadCountForTest,
  _getNativeChatSenderCleanupCountForTest,
  _getNativeChatSetupAttemptCountForTest,
  clearNativeChatSubscriptions,
  registerNativeChatHandlers
} from './native-chat'
import {
  MAX_NATIVE_CHAT_DESKTOP_READ_LIMIT,
  MAX_NATIVE_CHAT_READS_PER_SENDER,
  MAX_NATIVE_CHAT_SESSION_ID_BYTES,
  MAX_NATIVE_CHAT_SETUP_ATTEMPTS_PER_SENDER,
  MAX_NATIVE_CHAT_SUBSCRIPTIONS_PROCESS_WIDE,
  MAX_NATIVE_CHAT_SUBSCRIPTIONS_PER_SENDER,
  MAX_NATIVE_CHAT_SUBSCRIPTION_ID_BYTES
} from './native-chat-ipc-admission'

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
    removeListener: (event: string, callback: () => void) => void
    send: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  clearNativeChatSubscriptions()
  handlers.clear()
  listeners.clear()
  readTranscriptTail.mockReset()
  readTranscriptTail.mockResolvedValue({ messages: [], hasMore: false, beforeOffset: 0 })
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
      for (const callback of destroyedCallbacks.slice()) {
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
      removeListener: (event, callback) => {
        if (event !== 'destroyed') {
          return
        }
        const index = destroyedCallbacks.indexOf(callback)
        if (index >= 0) {
          destroyedCallbacks.splice(index, 1)
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
  error?: string,
  lifecycle?: NativeChatTurnLifecycle
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
  it('clamps read and watch windows before transcript work starts', async () => {
    const read = handlers.get('nativeChat:readSession')
    if (!read) {
      throw new Error('read handler not registered')
    }
    await read(
      { sender: { id: 9 } },
      { agent: 'claude', sessionId: 'session', limit: Number.MAX_SAFE_INTEGER }
    )
    expect(readTranscriptTail).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_NATIVE_CHAT_DESKTOP_READ_LIMIT })
    )

    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(10)
    const listener = listeners.get('nativeChat:subscribe')!
    listener(
      { sender: renderer.sender },
      {
        subscriptionId: 'bounded-window',
        agent: 'claude',
        sessionId: 'session',
        limit: Number.MAX_SAFE_INTEGER
      }
    )
    expect(subscribeTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ initialLimit: MAX_NATIVE_CHAT_DESKTOP_READ_LIMIT })
    )
    pending.resolve()
    await waitFor(() => _getNativeChatSetupAttemptCountForTest() === 0)
    renderer.destroy()
  })

  it('rejects oversized retained identifiers before starting transcript work', async () => {
    const renderer = createSender(11)
    subscribe(renderer.sender, 'x'.repeat(MAX_NATIVE_CHAT_SUBSCRIPTION_ID_BYTES + 1))
    const listener = listeners.get('nativeChat:subscribe')!
    listener(
      { sender: renderer.sender },
      {
        subscriptionId: 'valid',
        agent: 'claude',
        sessionId: 'x'.repeat(MAX_NATIVE_CHAT_SESSION_ID_BYTES + 1)
      }
    )

    expect(subscribeTranscript).not.toHaveBeenCalled()
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(0)
    expect(_getNativeChatSetupAttemptCountForTest()).toBe(0)
  })

  it('bounds concurrent transcript pages per renderer and releases admission', async () => {
    let releaseReads!: (value: {
      messages: never[]
      hasMore: boolean
      beforeOffset: number
    }) => void
    const readGate = new Promise<{
      messages: never[]
      hasMore: boolean
      beforeOffset: number
    }>((resolve) => {
      releaseReads = resolve
    })
    readTranscriptTail.mockReturnValue(readGate)
    const read = handlers.get('nativeChat:readSession')!
    const reads = Array.from({ length: MAX_NATIVE_CHAT_READS_PER_SENDER }, () =>
      read({ sender: { id: 20 } }, { agent: 'claude', sessionId: 'session' })
    )

    await vi.waitFor(() =>
      expect(_getNativeChatReadCountForTest()).toBe(MAX_NATIVE_CHAT_READS_PER_SENDER)
    )
    await expect(
      read({ sender: { id: 20 } }, { agent: 'claude', sessionId: 'session' })
    ).resolves.toEqual({ error: 'Too many concurrent native chat transcript reads' })
    expect(readTranscriptTail).toHaveBeenCalledTimes(MAX_NATIVE_CHAT_READS_PER_SENDER)

    releaseReads({ messages: [], hasMore: false, beforeOffset: 0 })
    await Promise.all(reads)
    expect(_getNativeChatReadCountForTest()).toBe(0)
  })

  it('caps unique logical subscriptions per renderer and recovers after unsubscribe', async () => {
    subscribeTranscript.mockImplementation(async () => ({
      unsubscribe: vi.fn(),
      watching: true
    }))
    const renderer = createSender(12)
    for (let index = 0; index < MAX_NATIVE_CHAT_SUBSCRIPTIONS_PER_SENDER; index++) {
      subscribe(renderer.sender, `sub-${index}`)
    }
    subscribe(renderer.sender, 'one-over')
    await waitFor(() => _getNativeChatSetupAttemptCountForTest() === 0)

    expect(subscribeTranscript).toHaveBeenCalledTimes(MAX_NATIVE_CHAT_SUBSCRIPTIONS_PER_SENDER)
    expect(_getNativeChatLiveSubscriptionCountForTest()).toBe(
      MAX_NATIVE_CHAT_SUBSCRIPTIONS_PER_SENDER
    )

    unsubscribe(renderer.sender, 'sub-0')
    subscribe(renderer.sender, 'after-release')
    await waitFor(() => _getNativeChatSetupAttemptCountForTest() === 0)
    expect(subscribeTranscript).toHaveBeenCalledTimes(MAX_NATIVE_CHAT_SUBSCRIPTIONS_PER_SENDER + 1)
    renderer.destroy()
  })

  it('caps logical subscriptions across renderers process-wide', async () => {
    subscribeTranscript.mockImplementation(async () => ({
      unsubscribe: vi.fn(),
      watching: true
    }))
    const rendererCount = Math.ceil(
      MAX_NATIVE_CHAT_SUBSCRIPTIONS_PROCESS_WIDE / MAX_NATIVE_CHAT_SUBSCRIPTIONS_PER_SENDER
    )
    const renderers = Array.from({ length: rendererCount + 1 }, (_, index) =>
      createSender(100 + index)
    )
    for (let index = 0; index < MAX_NATIVE_CHAT_SUBSCRIPTIONS_PROCESS_WIDE; index++) {
      const renderer = renderers[Math.floor(index / MAX_NATIVE_CHAT_SUBSCRIPTIONS_PER_SENDER)]
      subscribe(renderer.sender, `global-${index}`)
    }
    subscribe(renderers.at(-1)!.sender, 'global-one-over')
    await waitFor(() => _getNativeChatSetupAttemptCountForTest() === 0)

    expect(subscribeTranscript).toHaveBeenCalledTimes(MAX_NATIVE_CHAT_SUBSCRIPTIONS_PROCESS_WIDE)
    expect(_getNativeChatLiveSubscriptionCountForTest()).toBe(
      MAX_NATIVE_CHAT_SUBSCRIPTIONS_PROCESS_WIDE
    )
    renderers.forEach((renderer) => renderer.destroy())
  })

  it('caps unresolved same-id setup attempts without displacing the latest admitted setup', async () => {
    const pending = Array.from(
      { length: MAX_NATIVE_CHAT_SETUP_ATTEMPTS_PER_SENDER },
      deferredSubscription
    )
    for (const setup of pending) {
      subscribeTranscript.mockReturnValueOnce(setup.promise)
    }
    const renderer = createSender(13)
    for (let index = 0; index < pending.length; index++) {
      subscribe(renderer.sender, 'same-id-storm')
    }
    subscribe(renderer.sender, 'same-id-storm')

    expect(subscribeTranscript).toHaveBeenCalledTimes(MAX_NATIVE_CHAT_SETUP_ATTEMPTS_PER_SENDER)
    expect(_getNativeChatSetupAttemptCountForTest()).toBe(MAX_NATIVE_CHAT_SETUP_ATTEMPTS_PER_SENDER)
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(1)

    pending.forEach((setup) => setup.resolve())
    await waitFor(() => _getNativeChatSetupAttemptCountForTest() === 0)
    expect(pending.slice(0, -1).every((setup) => setup.unsubscribe.mock.calls.length === 1)).toBe(
      true
    )
    expect(pending.at(-1)?.unsubscribe).not.toHaveBeenCalled()
    renderer.destroy()
  })

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
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)
    expect(renderer.registeredCleanupCount()).toBe(0)
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
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)
    expect(renderer.registeredCleanupCount()).toBe(0)

    subscribe(renderer.sender, 'retry')
    expect(renderer.registeredCleanupCount()).toBe(1)
    retry.resolve()
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)
    unsubscribe(renderer.sender, 'retry')
    expect(retry.unsubscribe).toHaveBeenCalledOnce()
    expect(renderer.registeredCleanupCount()).toBe(0)
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
      frame: {
        type: 'snapshot',
        messages: [],
        hasMore: false
      }
    })
  })

  it('forwards replayable lifecycle on the initial snapshot', () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(7)
    const lifecycle = { state: 'completed', turnId: 'turn-1', timestamp: 42 } as const

    subscribe(renderer.sender, 'lifecycle')
    initialSnapshot(0)([], false, 0, undefined, lifecycle)

    expect(renderer.sender.send).toHaveBeenCalledWith('nativeChat:appended', {
      subscriptionId: 'lifecycle',
      frame: {
        type: 'snapshot',
        messages: [],
        hasMore: false,
        lifecycle
      }
    })
  })
})
