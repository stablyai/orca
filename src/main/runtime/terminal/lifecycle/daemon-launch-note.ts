import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { DaemonLaunchNote } from '../../../daemon/protocol/daemon-launch-note-protocol'
import { daemonLaunchNoteOf } from '../launch/attested-launch-config'
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
    const note = daemonLaunchNoteOf(pty)
    if (note) {
      this.ptyController?.setLaunchNote?.(ptyId, note)
    }
  }

  /** Nothing reaches a daemon PTY while main is down, so the agent still in the foreground is the
   *  one the unretired note launched; anything else, including every Windows read, declines. */
  protected async rearmReattachedLaunch(
    ptyId: string,
    pty: RuntimePtyWorktreeRecord,
    reattach: { incarnationId: string; launchAgent: TuiAgent; launchNote?: DaemonLaunchNote }
  ): Promise<void> {
    const { launchNote, launchAgent, incarnationId } = reattach
    if (!launchNote) {
      return
    }
    const foreground = await this.readLaunchedAgentForeground(ptyId, launchAgent).catch(
      () => 'unknown' as const
    )
    if (foreground === 'shell') {
      this.ptyController?.setLaunchNote?.(ptyId, null)
    }
    if (
      foreground === 'agent' &&
      this.ptysById.get(ptyId) === pty &&
      pty.incarnationId === incarnationId &&
      pty.launchAgent === launchAgent &&
      !pty.launchToken
    ) {
      pty.launchToken = launchNote.launchToken
      pty.launchIncarnationId = incarnationId
      pty.launchConfig = launchNote.launchConfig
    }
  }
}
