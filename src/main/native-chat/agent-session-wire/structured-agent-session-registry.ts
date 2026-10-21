// Where the RPC layer finds the host.
//
// The runtime service is already far past its size budget, so structured
// sessions hang off a module-level slot instead of another field on it — the
// same shape the native-chat RPC methods use to reach their own collaborators.
// Tests install a host with a stub adapter and clear it on teardown.

import type { StructuredAgentSessionHost } from './structured-agent-session-host'

let host: StructuredAgentSessionHost | null = null
let held = false
let stopWatchingHost: (() => void) | null = null
const heldListeners = new Set<(held: boolean) => void>()

// Why typeof: tests install partial hosts.
function hostHoldsSessions(candidate: StructuredAgentSessionHost | null): boolean {
  return typeof candidate?.holdsSessions === 'function' && candidate.holdsSessions()
}

// A notification must never fail the install that triggered it: a retry would build a second host.
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
  host = next
  try {
    stopWatchingHost =
      typeof next?.onSessionsHeld === 'function' ? next.onSessionsHeld(publishHeld) : null
  } catch (error) {
    console.warn('[structured-agent-session] watching for held chats failed', error)
  }
  publishHeld()
}

/** Whether this runtime holds a structured chat, saved or live; building the host alone is not one. */
export function structuredAgentSessionsHeld(): boolean {
  return hostHoldsSessions(host)
}

/** Called each time that answer changes, e.g. when the first chat here is restored or created. */
export function onStructuredAgentSessionsHeldChanged(
  listener: (held: boolean) => void
): () => void {
  heldListeners.add(listener)
  return () => heldListeners.delete(listener)
}

export function getStructuredAgentSessionHost(): StructuredAgentSessionHost | null {
  return host
}
