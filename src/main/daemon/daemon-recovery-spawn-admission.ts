import type { PtySpawnOptions } from '../providers/types'
import { STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'

export function assertDaemonRecoverySpawnAdmission(
  recoveryOnly: boolean,
  protocolVersion: number,
  opts: PtySpawnOptions
): void {
  if (!recoveryOnly) {
    return
  }
  // Legacy attach emulation can create before rejecting the result.
  if (
    opts.attachOnly !== true ||
    !opts.sessionId ||
    opts.agentSessionEnsure ||
    protocolVersion < STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION
  ) {
    throw new Error('Terminal daemon admission is fenced for managed-stop recovery')
  }
}
