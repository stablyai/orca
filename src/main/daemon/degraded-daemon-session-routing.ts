import type { IPtyProvider } from '../providers/types'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'

export function listProviderSessionIds(
  sessionProviders: ReadonlyMap<string, IPtyProvider>,
  provider: IPtyProvider
): string[] {
  return [...sessionProviders]
    .filter(([, mappedProvider]) => mappedProvider === provider)
    .map(([id]) => id)
}

/** Attach-only session adoption: refuses the in-process fallback route. A
 *  fallback pty cannot own a daemon-surviving session by definition, and its
 *  no-op attach resolving would pin a subscriber-driven attach as succeeded
 *  while the stream stays blank. */
export async function attachDaemonOwnedSession(
  owner: IPtyProvider,
  fallback: IPtyProvider,
  sessionId: string
): ReturnType<IPtyProvider['attach']> {
  if (owner === fallback) {
    throw new SessionNotFoundError(sessionId)
  }
  return await owner.attach(sessionId)
}

/**
 * Session operations that must never be answered by the in-process fallback on another
 * provider's behalf. An unknown id resolves to the fallback, whose shutdown returns
 * silently and whose write/resize are no-ops — so a daemon-owned session reads as closed
 * while its agent keeps running, and typing into it disappears. Route there only when the
 * fallback genuinely owns the pty; otherwise say the session cannot be reached.
 *
 * Why not SessionNotFoundError: pty:kill treats "Session not found" as proof the pty is
 * already gone and synthesizes an exit, which is the same lie by another route. This one
 * means "still there, we just cannot reach its host", so the kill is reported as failed and
 * ownership is kept for a retry.
 */
export function ownerForDaemonOwnedOperation(
  owner: IPtyProvider,
  fallback: IPtyProvider,
  sessionId: string
): IPtyProvider {
  if (owner === fallback && fallback.hasPty?.(sessionId) !== true) {
    throw new TerminalSessionOwnerUnverifiedError(sessionId)
  }
  return owner
}

/** Probes providers for an id absent from the routing map and adopts the
 *  first proven owner into the map. */
export function adoptOwningProvider(
  sessionProviders: Map<string, IPtyProvider>,
  providers: readonly IPtyProvider[],
  sessionId: string
): IPtyProvider | null {
  for (const provider of providers) {
    if (provider.hasPty?.(sessionId) === true) {
      sessionProviders.set(sessionId, provider)
      return provider
    }
  }
  return null
}

export function findDaemonAdapter(
  sessionProviders: ReadonlyMap<string, IPtyProvider>,
  daemonAdapters: readonly DaemonPtyAdapter[],
  sessionId: string
): DaemonPtyAdapter | null {
  const provider = sessionProviders.get(sessionId)
  return provider && daemonAdapters.includes(provider as DaemonPtyAdapter)
    ? (provider as DaemonPtyAdapter)
    : null
}
