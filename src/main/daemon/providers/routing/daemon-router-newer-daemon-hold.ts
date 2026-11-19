import { NEWER_DAEMON_HOLD_ERROR } from '../../../../shared/terminal/daemon/newer-daemon-hold'
import type { PtyHeldSpawnRequest } from '../../../providers/pty/provider-contract'
import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

/** The saved id to hold, or null for a routed session, a new one, or no newer daemon. */
function heldSessionId(opts: PtyHeldSpawnRequest, routed: boolean): string | null {
  const { sessionId } = opts
  // Missing history doesn't prove the saved shell exited, so every saved id holds until an owner answers.
  return routed || !sessionId || opts.isNewSession || !isHoldingForNewerProtocolDaemon()
    ? null
    : sessionId
}

async function resolveHeldOwner(
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

/** Gate every spawn source against duplicating sessions a newer, unadoptable daemon may still own. */
export async function routeSpawnOrHold(
  opts: PtyHeldSpawnRequest,
  routed: DaemonPtyAdapter | undefined,
  current: DaemonPtyAdapter,
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
): Promise<DaemonPtyAdapter> {
  const sessionId = heldSessionId(opts, routed !== undefined)
  return sessionId === null ? (routed ?? current) : resolveHeldOwner(sessionId, ownerResolver)
}

/** The same hold, answered before main prepares anything under the saved id; undefined when none applies. */
export function heldSpawnRefusal(
  getOwnerResolver: () => DaemonSessionOwnerResolver<DaemonPtyAdapter>
): (opts: PtyHeldSpawnRequest) => Promise<void> | undefined {
  return (opts) => {
    const ownerResolver = getOwnerResolver()
    const routed = opts.sessionId !== undefined && ownerResolver.hasRoute(opts.sessionId)
    const sessionId = opts.attachOnly ? null : heldSessionId(opts, routed)
    return sessionId === null
      ? undefined
      : resolveHeldOwner(sessionId, ownerResolver).then(() => {})
  }
}
