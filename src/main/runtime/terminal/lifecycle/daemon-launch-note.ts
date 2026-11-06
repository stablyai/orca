import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { DaemonLaunchNote } from '../../../daemon/protocol/daemon-launch-note-protocol'
import type { LaunchedAgentForeground } from '../wait/launched-agent-foreground'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { OrcaRuntimeWithInvalidateAllHandlesForPty } from './pty-handle-invalidation'

/** Main's admitted launch, kept in the daemon so a reattach after a main restart can re-arm it. */
export abstract class OrcaRuntimeWithDaemonLaunchNote extends OrcaRuntimeWithInvalidateAllHandlesForPty {
  abstract readLaunchedAgentForeground(
    ptyId: string,
    agent: TuiAgent
  ): Promise<LaunchedAgentForeground>

  /** Keep main's admitted launch in the daemon, which outlives main. */
  protected armDaemonLaunchNote(ptyId: string, pty: RuntimePtyWorktreeRecord): void {
    if (pty.launchToken && pty.launchConfig) {
      this.ptyController?.setLaunchNote?.(ptyId, {
        arm: { launchToken: pty.launchToken, launchConfig: pty.launchConfig }
      })
    }
  }

  /** Re-arm an unretired launch only while an agent holds the foreground. Main can't tell when the
   *  host keeps no notes (an older daemon) or the foreground is unreadable (Windows), so it stays undecided. */
  protected async rearmReattachedLaunch(
    ptyId: string,
    pty: RuntimePtyWorktreeRecord,
    reattach: { incarnationId: string; launchAgent: TuiAgent; launchNote?: DaemonLaunchNote | null }
  ): Promise<void> {
    const { launchNote, launchAgent, incarnationId } = reattach
    if (pty.launchToken) {
      return
    }
    if (launchNote === null) {
      // The daemon saw this launch finish, which settles a pane an earlier attach left undecided.
      pty.launchUndecided = false
      return
    }
    pty.launchUndecided = true
    if (!launchNote) {
      return
    }
    const foreground = await this.readLaunchedAgentForeground(ptyId, launchAgent).catch(
      () => 'unknown' as const
    )
    // A launch main already holds for this PTY is newer than anything the reattach can say.
    if (
      this.ptysById.get(ptyId) !== pty ||
      pty.incarnationId !== incarnationId ||
      pty.launchToken
    ) {
      return
    }
    if (foreground === 'shell') {
      this.ptyController?.setLaunchNote?.(ptyId, { retire: launchNote.launchToken })
      pty.launchUndecided = false
    }
    if (foreground === 'agent' && pty.launchAgent === launchAgent) {
      pty.launchUndecided = false
      pty.launchToken = launchNote.launchToken
      pty.launchIncarnationId = incarnationId
      pty.launchConfig = launchNote.launchConfig
    }
  }
}
