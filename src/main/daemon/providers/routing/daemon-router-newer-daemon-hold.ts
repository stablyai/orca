import { NEWER_DAEMON_HOLD_ERROR } from '../../../../shared/terminal/daemon/newer-daemon-hold'
import type { PtyHeldSpawnRequest } from '../../../providers/pty/provider-contract'
import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import type { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import { findLegacySessionOwner } from './daemon-router-legacy-owner'

/** The saved id to hold, or null for a routed session, a new one, or no newer daemon. */
function heldSessionId(opts: PtyHeldSpawnRequest, routed: boolean): string | null {
  const { sessionId } = opts
  // Missing history doesn't prove the saved shell exited, so every saved id holds until an owner answers.
  return routed || !sessionId || opts.isNewSession || !isHoldingForNewerProtocolDaemon()
    ? null
    : sessionId
}

export async function resolveHeldOwner(
  sessionId: string,
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
): Promise<DaemonPtyAdapter> {
  // Unknown inventory cannot authorize a duplicate shell or agent.
  const resolution = await ownerResolver.resolve(sessionId)
  if (resolution.kind !== 'owner') {
    throw new Error(NEWER_DAEMON_HOLD_ERROR)
  }
  return resolution.provider
}

/** Spawn dispatch's target: the routed owner, else a probed current or legacy owner, else the newer-daemon hold. */
export async function routeSpawnOrHold(
  opts: PtyHeldSpawnRequest,
  router: {
    sessionAdapters: ReadonlyMap<string, DaemonPtyAdapter>
    current: DaemonPtyAdapter
    legacy: readonly DaemonPtyAdapter[]
    exitProof: LegacyDaemonExitProof
    ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
  }
): Promise<DaemonPtyAdapter> {
  const { sessionAdapters, current, legacy, exitProof, ownerResolver } = router
  const owner =
    (opts.sessionId ? sessionAdapters.get(opts.sessionId) : undefined) ??
    (await findLegacySessionOwner(opts, current, legacy, exitProof))
  const sessionId = heldSessionId(opts, owner !== undefined)
  return sessionId === null ? (owner ?? current) : resolveHeldOwner(sessionId, ownerResolver)
}

/** The same hold, answered before main prepares anything under the saved id; undefined when none applies. */
export function heldSpawnRefusal(
  hasRoute: (sessionId: string) => boolean,
  // The dispatch's own owner lookup, so the early answer never differs from the spawn's.
  resolveHeld: (opts: PtyHeldSpawnRequest & { sessionId: string }) => Promise<unknown>
): (opts: PtyHeldSpawnRequest) => Promise<void> | undefined {
  return (opts) => {
    const routed = opts.sessionId !== undefined && hasRoute(opts.sessionId)
    const sessionId = opts.attachOnly ? null : heldSessionId(opts, routed)
    return sessionId === null ? undefined : resolveHeld({ ...opts, sessionId }).then(() => {})
  }
}
