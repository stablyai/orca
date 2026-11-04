import { NEWER_DAEMON_HOLD_ERROR } from '../../shared/newer-daemon-hold'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

/** Gate every spawn source against duplicating sessions a newer, unadoptable daemon may still own. */
export async function routeSpawnOrHold(
  opts: Pick<PtySpawnOptions, 'sessionId'>,
  routed: DaemonPtyAdapter | undefined,
  current: DaemonPtyAdapter,
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
): Promise<DaemonPtyAdapter> {
  const { sessionId } = opts
  if (
    routed ||
    !sessionId ||
    !isHoldingForNewerProtocolDaemon() ||
    !current.hasRestorableHistory(sessionId)
  ) {
    return routed ?? current
  }
  // Unknown inventory cannot authorize a duplicate shell or agent.
  const resolution = await ownerResolver.resolve(sessionId)
  if (resolution.kind !== 'owner') {
    throw new Error(NEWER_DAEMON_HOLD_ERROR)
  }
  return resolution.provider
}
