import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'
import type { DaemonLaunchNote } from '../../../daemon/protocol/daemon-launch-note-protocol'
import type { LaunchedAgentForeground } from '../wait/launched-agent-foreground'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import {
  holdLaunch,
  recordReattachedLaunch,
  retireLaunch,
  type LaunchEvidence
} from '../launch/launch-evidence'
import { OrcaRuntimeWithInvalidateAllHandlesForPty } from './pty-handle-invalidation'

/** Main's admitted launch, kept in the daemon so a reattach after a main restart can re-arm it. */
export abstract class OrcaRuntimeWithDaemonLaunchNote extends OrcaRuntimeWithInvalidateAllHandlesForPty {
  abstract readLaunchedAgentForeground(
    ptyId: string,
    agent?: TuiAgent
  ): Promise<LaunchedAgentForeground>

  protected abstract watchLaunchComposer(ptyId: string, agent: TuiAgent | null): void

  /** Watch a launched agent's composer and keep its launch in the daemon. */
  protected watchLaunchedAgent(pty: RuntimePtyWorktreeRecord, agent: TuiAgent | null): void {
    this.watchLaunchComposer(pty.ptyId, agent)
    this.armDaemonLaunchNote(pty)
  }

  /** Keep main's held launch in the daemon, which outlives main. */
  protected armDaemonLaunchNote(pty: RuntimePtyWorktreeRecord): void {
    const evidence = pty.launchEvidence
    if (evidence?.kind === 'held') {
      this.ptyController?.setLaunchNote?.(pty.ptyId, {
        arm: { launchToken: evidence.token, launchConfig: evidence.config }
      })
    }
  }

  /** A finished command or confirmed exit; the daemon outlives main, so a reattach must not re-arm it. */
  protected retireHeldLaunch(ptyId: string): RuntimePtyWorktreeRecord | undefined {
    const pty = this.ptysById.get(ptyId)
    if (pty?.launchEvidence?.kind === 'held') {
      this.ptyController?.setLaunchNote?.(ptyId, { retire: pty.launchEvidence.token })
    }
    if (pty) {
      retireLaunch(pty)
    }
    return pty
  }

  /** An unretired note is held only while its agent still holds the foreground. Main can't tell when
   *  the host keeps no notes (an older daemon) or the foreground is unreadable (Windows). */
  protected recordReattachedLaunch(
    pty: RuntimePtyWorktreeRecord,
    incarnationId: PtyIncarnationId | undefined,
    note: DaemonLaunchNote | null | undefined,
    agent: TuiAgent | undefined
  ): void {
    const pending = recordReattachedLaunch(pty, incarnationId, note)
    if (pending && note && incarnationId && agent) {
      void this.checkReattachedLaunch(pty, pending, incarnationId, note, agent)
    }
  }

  private async checkReattachedLaunch(
    pty: RuntimePtyWorktreeRecord,
    pending: LaunchEvidence,
    incarnationId: PtyIncarnationId,
    note: DaemonLaunchNote,
    agent: TuiAgent
  ): Promise<void> {
    const foreground = await this.readLaunchedAgentForeground(pty.ptyId, agent).catch(
      () => 'unknown' as const
    )
    // Newer evidence (a later attach, a finished command, a fresh launch) outranks this read.
    if (
      pty.launchEvidence !== pending ||
      this.ptysById.get(pty.ptyId) !== pty ||
      pty.incarnationId !== incarnationId
    ) {
      return
    }
    if (foreground === 'shell') {
      this.ptyController?.setLaunchNote?.(pty.ptyId, { retire: note.launchToken })
      retireLaunch(pty)
    } else if (foreground === 'agent' && pty.launchAgent === agent) {
      holdLaunch(pty, incarnationId, { agent, token: note.launchToken, config: note.launchConfig })
    }
  }
}
