import { OrcaRuntimeWithOnClientDisconnected } from '../layout/terminal-client-disconnect'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

import { closedPaneOfExitedPty, type ClosedPaneOfExit } from './closed-pane-of-exited-pty'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

export abstract class RuntimePtyExitSurfaceReads extends OrcaRuntimeWithOnClientDisconnected {
  /** The pane main's close already dropped, from its closed-pane record; null while main holds it. */
  protected closedPaneOfExit(
    pty: RuntimePtyWorktreeRecord | undefined,
    exitIncarnationId: PtyIncarnationId | undefined
  ): ClosedPaneOfExit | null {
    if (!ORCA_LAYOUT_OWNER_IS_MAIN || !pty || this.paneOfPty(pty).paneKey) {
      return null
    }
    return closedPaneOfExitedPty(
      this.store,
      this.tryGetWorkspaceSessionHostIdForWorktree(pty.worktreeId),
      pty,
      exitIncarnationId ?? pty.incarnationId
    )
  }

  protected notifyPtyExitListeners(ptyId: string): void {
    const listeners = this.ptyExitListenersByPtyId.get(ptyId)
    if (!listeners) {
      return
    }
    this.ptyExitListenersByPtyId.delete(ptyId)
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A subscriber cannot change exit cleanup for other waiters.
      }
    }
  }
}
