import { OrcaRuntimeWithClientTerminalScrollback } from '../../terminal/output/runtime-client-scrollback'
import type { WslMoveLiveTerminal } from '../../../persistence/moving-wsl-projects/wsl-move-gate-facts'

export abstract class OrcaRuntimeWithWslMoveTerminalFacts extends OrcaRuntimeWithClientTerminalScrollback {
  /** The pane a live terminal shows, including one the window has not reopened since a relaunch. */
  wslMovePaneKeyForPty(ptyId: string): string | null {
    const pty = this.ptysById.get(ptyId)
    return pty ? this.paneOfPty(pty).paneKey : null
  }

  /** This desktop's live terminals in the workspaces, for a WSL move's gate and pause. */
  listWslMoveLiveTerminals(workspaceIds: readonly string[]): WslMoveLiveTerminal[] {
    const terminals = new Map<string, WslMoveLiveTerminal>()
    for (const workspaceId of workspaceIds) {
      // Local only: a same-id SSH twin's terminals are another host's.
      for (const ptyId of this.getLivePtyIdsForWorktree(workspaceId, undefined, {
        resolvedConnectionId: null
      })) {
        const pty = this.ptysById.get(ptyId)
        terminals.set(ptyId, {
          ptyId,
          workspaceId,
          paneKey: pty ? this.paneOfPty(pty).paneKey : null,
          wslDistro: pty?.wslDistro ?? null,
          foregroundAgent: pty?.foregroundAgent ?? null
        })
      }
    }
    return [...terminals.values()]
  }
}
