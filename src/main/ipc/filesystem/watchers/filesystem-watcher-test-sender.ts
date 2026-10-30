import { vi, type Mock } from 'vitest'

type SenderEvents = { on: Mock; removeListener: Mock }

export function senderEvents(): SenderEvents {
  return { on: vi.fn(), removeListener: vi.fn() }
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

/** Fires the live (registered, not removed) `on` handlers for `event`, as Electron would. */
export function fireWatcherSenderEvent(sender: SenderEvents, event: string): void {
  const removed = new Set(sender.removeListener.mock.calls.map(([, callback]) => callback))
  for (const [name, callback] of sender.on.mock.calls) {
    if (name === event && !removed.has(callback)) {
      sender.removeListener(name, callback)
      callback()
    }
  }
}
