import type { WorkOrigin } from '../../shared/work-origin'
import type { PtySpawnResult } from '../providers/pty-spawn-result'

export function resolveTerminalCreateWorkOrigin(
  runtime: { getPaneWorkOrigin(worktreeId: string, paneKey: string): WorkOrigin | undefined },
  worktreeId: string,
  paneKey: string,
  canAdoptPaneIdentity: boolean,
  requested: WorkOrigin | undefined
): WorkOrigin {
  const retained = canAdoptPaneIdentity ? runtime.getPaneWorkOrigin(worktreeId, paneKey) : undefined
  return requested !== undefined ? requested : retained === undefined ? { kind: 'host' } : retained
}

export function applyCreatedTerminalWorkOrigin(
  pty: { workOrigin?: WorkOrigin },
  result: PtySpawnResult,
  requested: WorkOrigin
): void {
  if (result.workOrigin !== undefined) {
    pty.workOrigin = result.workOrigin
  } else if (!result.isReattach) {
    pty.workOrigin = requested
  }
}
