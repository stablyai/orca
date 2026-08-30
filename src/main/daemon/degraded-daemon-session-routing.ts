import type { IPtyProvider } from '../providers/types'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { SessionNotFoundError } from './daemon-errors'

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

/** Probes providers for an id absent from the routing map and adopts the
 *  first proven owner into the map. */
/**
 * Whether any session still routed to `provider` is one it still holds a PTY for.
 *
 * An id the provider cannot answer for counts as alive: an undetermined answer must never be
 * spent as proof that the work is gone (docs/reference/ssh-execution-boundary.md).
 */
export function hasLiveProviderPtys(
  sessionProviders: ReadonlyMap<string, IPtyProvider>,
  provider: IPtyProvider
): boolean {
  return listProviderSessionIds(sessionProviders, provider).some(
    (id) => provider.hasPty?.(id) ?? true
  )
}

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
