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

/** Carries this link on to its next step under the same id; a newer link is left alone. */
export function continueBotLink(id: number, target: BotLinkTarget): void {
  if (pending?.id === id) {
    pending = { id, target }
    notify()
  }
}

/** True while this exact entry is pending: not cleared, replaced by a newer link, or moved on a step. */
export function isPendingBotLink(link: PendingBotLink): boolean {
  return pending === link
}

/** Aborts `attempt` synchronously the moment `link` stops being pending, before React unmounts its
 *  resolver, so its in-flight work cannot navigate, alert or send for a superseded link. */
export function abortWhenNotPending(link: PendingBotLink, attempt: AbortController): () => void {
  const check = () => {
    if (pending !== link) {
      attempt.abort()
    }
  }
  check()
  listeners.add(check)
  return () => listeners.delete(check)
}

/** Counts published links; clearing or continuing a link leaves it, so it says whether any newer link came. */
export function botLinkPublishGeneration(): number {
  return nextId
}

export function readPendingBotLink(): PendingBotLink | null {
  return pending
}

export function subscribeToPendingBotLink(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
