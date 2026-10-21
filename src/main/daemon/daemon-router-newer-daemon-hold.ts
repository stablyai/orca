import { NEWER_DAEMON_HOLD_ERROR } from '../../shared/newer-daemon-hold'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

/**
 * The adapter a spawn routes to, refusing with the hold marker a cold restore of an id no adopted
 * daemon owns while a newer daemon this build cannot adopt may still run it. Why at the router:
 * every spawn source (IPC, runtime controller, mobile, CLI) reaches it, and restoring would start
 * a second shell, and agent, beside the newer build's still-running one.
 */
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
  // Why: an unanswered inventory holds too; a wrong hold costs a click, a wrong release an agent.
  const resolution = await ownerResolver.resolve(sessionId)
  if (resolution.kind !== 'owner') {
    throw new Error(NEWER_DAEMON_HOLD_ERROR)
  }
  return resolution.provider
}
