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
