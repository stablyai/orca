import { vi, type Mock } from 'vitest'

type SenderEvents = { once: Mock; removeListener: Mock }

export function senderEvents(): SenderEvents {
  return { once: vi.fn(), removeListener: vi.fn() }
}

export function createWatcherSender(
  id: number,
  send: Mock = vi.fn()
): SenderEvents & {
  id: number
  isDestroyed: () => boolean
  send: Mock
} {
  return { id, isDestroyed: () => false, send, ...senderEvents() }
}

/** Fires the live (registered, not removed, not yet fired) `once` handlers for `event`, as Electron would. */
export function fireWatcherSenderEvent(sender: SenderEvents, event: string): void {
  const removed = new Set(sender.removeListener.mock.calls.map(([, callback]) => callback))
  for (const [name, callback] of sender.once.mock.calls) {
    if (name === event && !removed.has(callback)) {
      sender.removeListener(name, callback)
      callback()
    }
  }
}
