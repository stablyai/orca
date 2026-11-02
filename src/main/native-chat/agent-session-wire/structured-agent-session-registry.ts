import { sessionCrewChanges } from '../../runtime/orchestration/crew/crew-changes'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

let host: StructuredAgentSessionHost | null = null
let held = false
let stopWatchingHost: (() => void) | null = null
const heldListeners = new Set<(held: boolean) => void>()

// Partial test hosts may omit holdsSessions.
function hostHoldsSessions(candidate: StructuredAgentSessionHost | null): boolean {
  return typeof candidate?.holdsSessions === 'function' && candidate.holdsSessions()
}

// Failed notification must not trigger host reinstallation and duplicate ownership.
function publishHeld(): void {
  try {
    const next = hostHoldsSessions(host)
    if (next === held) {
      return
    }
    held = next
    for (const listener of heldListeners) {
      try {
        listener(next)
      } catch (error) {
        console.warn('[structured-agent-session] a held-chats listener threw', error)
      }
    }
  } catch (error) {
    console.warn('[structured-agent-session] reading whether chats are held failed', error)
  }
}

export function setStructuredAgentSessionHost(next: StructuredAgentSessionHost | null): void {
  stopWatchingHost?.()
  stopWatchingHost = null
  const changed = host !== next
  host = next
  if (changed) {
    sessionCrewChanges.notify()
  }
  try {
    stopWatchingHost =
      typeof next?.onSessionsHeld === 'function' ? next.onSessionsHeld(publishHeld) : null
  } catch (error) {
    console.warn('[structured-agent-session] watching for held chats failed', error)
  }
  publishHeld()
}

/** Includes saved/live chats; constructing a host holds none. */
export function structuredAgentSessionsHeld(): boolean {
  return hostHoldsSessions(host)
}

export function onStructuredAgentSessionsHeldChanged(
  listener: (held: boolean) => void
): () => void {
  heldListeners.add(listener)
  return () => heldListeners.delete(listener)
}

export function getStructuredAgentSessionHost(): StructuredAgentSessionHost | null {
  return host
}
