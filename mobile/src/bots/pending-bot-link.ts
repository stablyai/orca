import type { BotLinkTarget } from './bot-link-target'

export type PendingBotLink = { id: number; target: BotLinkTarget }

// Held outside React: routing an orca:// URL remounts the root layout, which would drop component state.
let pending: PendingBotLink | null = null
let nextId = 0
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

/** A newer link replaces one still resolving, so only one is ever redeemed at a time. */
export function publishBotLink(target: BotLinkTarget): void {
  nextId += 1
  pending = { id: nextId, target }
  notify()
}

/** Clears only this link: a newer one may already be pending. */
export function clearBotLink(id: number): void {
  if (pending?.id === id) {
    pending = null
    notify()
  }
}

export function readPendingBotLink(): PendingBotLink | null {
  return pending
}

export function subscribeToPendingBotLink(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
