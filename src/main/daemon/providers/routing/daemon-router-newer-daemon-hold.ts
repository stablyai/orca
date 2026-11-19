import { NEWER_DAEMON_HOLD_ERROR } from '../../../../shared/terminal/daemon/newer-daemon-hold'
import type { PtySpawnOptions } from '../../../providers/pty/provider-contract'
import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

type HoldSpawnOptions = Pick<PtySpawnOptions, 'sessionId' | 'isNewSession'>

/** Gate every spawn source against duplicating sessions a newer, unadoptable daemon may still own. */
export async function routeSpawnOrHold<O extends HoldSpawnOptions>(
  opts: O,
  routed: DaemonPtyAdapter | undefined,
  current: DaemonPtyAdapter,
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
): Promise<{ target: DaemonPtyAdapter; opts: O }> {
  const { sessionId } = opts
  if (routed || !sessionId || !isHoldingForNewerProtocolDaemon()) {
    return { target: routed ?? current, opts }
  }
  if (!current.hasRestorableHistory(sessionId)) {
    // The newer daemon may still run this saved id; reusing it leaves that shell unreachable after the upgrade back.
    return { target: current, opts: opts.isNewSession ? opts : { ...opts, sessionId: undefined } }
  }
  // Unknown inventory cannot authorize a duplicate shell or agent.
  const resolution = await ownerResolver.resolve(sessionId)
  if (resolution.kind !== 'owner') {
    throw new Error(NEWER_DAEMON_HOLD_ERROR)
  }
  return { target: resolution.provider, opts }
}
