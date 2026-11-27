import { OrcaRuntimeWithOnClientDisconnected } from '../layout/terminal-client-disconnect'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'

import { closedPaneOfExitedPty, type ClosedPaneOfExit } from './closed-pane-of-exited-pty'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { RuntimeTerminalResolvePane } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

export abstract class RuntimePtyExitSurfaceReads extends OrcaRuntimeWithOnClientDisconnected {
  abstract resolveTerminalPane(paneKey: string): RuntimeTerminalResolvePane

  /** Another process, or a later incarnation of this one, already runs in the pane; with no
   *  `ptyId`, any connected process does. */
  protected paneHasSuccessorProcess(
    paneKey: string,
    ptyId: string | null,
    exitIncarnationId: PtyIncarnationId | undefined
  ): boolean {
    try {
      const current = this.resolveTerminalPane(paneKey)
      if (ptyId === null) {
        // A slept or host-lost terminal stays recorded in its pane, disconnected: no reader.
        return Boolean(current.ptyId && current.connected !== false)
      }
      return Boolean(
        current.ptyId &&
        (current.ptyId !== ptyId ||
          (exitIncarnationId &&
            current.incarnationId &&
            current.incarnationId !== exitIncarnationId))
      )
    } catch {
      // A closed pane has no successor process to protect.
      return false
    }
  }

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
