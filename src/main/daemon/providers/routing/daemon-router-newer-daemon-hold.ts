import { NEWER_DAEMON_HOLD_ERROR } from '../../../../shared/terminal/daemon/newer-daemon-hold'
import { SessionNotFoundError } from '../../protocol/daemon-errors'
import type { PtySpawnOptions } from '../../../providers/pty/provider-contract'
import type { PtySpawnResult } from '../../../providers/pty/spawn-result'
import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
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

/** This build's "not found" for a session a newer daemon may still run is no proof it ended: hold, so its pane keeps its binding. */
export async function attachOrHold(
  opts: PtySpawnOptions,
  sessionId: string,
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
  current: DaemonPtyAdapter
): Promise<PtySpawnResult> {
  try {
    return await ownerResolver.spawnAttachOnly({ ...opts, sessionId })
  } catch (error) {
    if (
      error instanceof SessionNotFoundError &&
      isHoldingForNewerProtocolDaemon() &&
      current.hasRestorableHistory(sessionId)
    ) {
      throw new Error(NEWER_DAEMON_HOLD_ERROR)
    }
    throw error
  }
}
