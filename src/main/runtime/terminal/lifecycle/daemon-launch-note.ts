import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { DaemonLaunchNote } from '../../../daemon/protocol/daemon-launch-note-protocol'
import type { LaunchedAgentForeground } from '../wait/launched-agent-foreground'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { OrcaRuntimeWithInvalidateAllHandlesForPty } from './pty-handle-invalidation'

/** Main's admitted launch, kept in the daemon so a reattach after a main restart can re-arm it. */
export abstract class OrcaRuntimeWithDaemonLaunchNote extends OrcaRuntimeWithInvalidateAllHandlesForPty {
  private readonly reattachedLaunchChecks = new Map<string, symbol>()

  abstract readLaunchedAgentForeground(
    ptyId: string,
    agent: TuiAgent
  ): Promise<LaunchedAgentForeground>

  /** Newer evidence (a later attach, a finished command) outranks a foreground read still in flight. */
  protected supersedeReattachedLaunchCheck(ptyId: string): void {
    this.reattachedLaunchChecks.delete(ptyId)
  }

  /** A finished command proves no earlier launch still runs in this PTY; returns its record. */
  protected settleReattachedLaunch(ptyId: string): RuntimePtyWorktreeRecord | undefined {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      pty.launchUndecided = false
    }
    this.supersedeReattachedLaunchCheck(ptyId)
    return pty
  }

  protected abstract watchLaunchComposer(ptyId: string, agent: TuiAgent | null): void

  /** Watch a launched agent's composer and keep its launch in the daemon. */
  protected watchLaunchedAgent(pty: RuntimePtyWorktreeRecord, agent: TuiAgent | null): void {
    this.watchLaunchComposer(pty.ptyId, agent)
    this.armDaemonLaunchNote(pty.ptyId, pty)
  }

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
    this.supersedeReattachedLaunchCheck(ptyId)
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
    const check = Symbol(ptyId)
    this.reattachedLaunchChecks.set(ptyId, check)
    const foreground = await this.readLaunchedAgentForeground(ptyId, launchAgent).catch(
      () => 'unknown' as const
    )
    const current = this.reattachedLaunchChecks.get(ptyId) === check
    if (current) {
      this.reattachedLaunchChecks.delete(ptyId)
    }
    // A launch main already holds for this PTY is newer than anything the reattach can say.
    if (
      !current ||
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
