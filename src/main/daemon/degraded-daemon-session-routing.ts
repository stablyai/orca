import type { IPtyProvider } from '../providers/types'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { SessionNotFoundError } from './daemon-errors'
import {
  inspectPtyProviderProcess,
  type PtyProcessInspection,
  type PtyProcessInspectionOptions
} from '../providers/pty-process-inspection'

/**
 * An id no route claims may only be asked about by a caller naming a remembered incarnation: that
 * is exactly the session that died while this client was away, so no route survived it. A daemon
 * that never held it answers not-found, so routing the question cannot manufacture an exit. An
 * ordinary poll must not borrow a route it never owned. Mirrors DaemonPtyRouter.
 */
export function inspectRoutedDaemonProcess(
  owner: IPtyProvider | null,
  currentDaemon: DaemonPtyAdapter,
  sessionId: string,
  options?: PtyProcessInspectionOptions
): Promise<PtyProcessInspection> {
  if (owner) {
    return inspectPtyProviderProcess(owner, sessionId, options)
  }
  return options?.expectedIncarnationId === undefined
    ? Promise.reject(new Error('terminal_gone'))
    : currentDaemon.inspectProcess(sessionId, options)
}

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
