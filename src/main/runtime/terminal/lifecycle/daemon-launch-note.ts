import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'
import type { DaemonLaunchNote } from '../../../daemon/protocol/daemon-launch-note-protocol'
import type { LaunchedAgentForeground } from '../wait/launched-agent-foreground'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../records/runtime-terminal-state-records'
import {
  isTerminalLeafId,
  makePaneKey,
  parsePaneKey
} from '../../../../shared/workspace-layout/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/workspace-layout/terminal-surfaces/terminal-tab-id'
import {
  holdLaunch,
  recordReattachedLaunch,
  retireLaunch,
  type LaunchEvidence
} from '../launch/launch-evidence'
import { OrcaRuntimeWithInvalidateAllHandlesForPty } from './pty-handle-invalidation'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'

/** The agent a host reports it launched in a surviving process, fenced to that process's incarnation. */
export type ReattachedLaunchIdentity = { incarnationId: PtyIncarnationId; launchAgent: TuiAgent }

/** Main's admitted launch, kept in the daemon so a reattach after a main restart can re-arm it. */
export abstract class OrcaRuntimeWithDaemonLaunchNote extends OrcaRuntimeWithInvalidateAllHandlesForPty {
  abstract readLaunchedAgentForeground(
    ptyId: string,
    agent: TuiAgent
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

  protected abstract getLeavesForPty(ptyId: string): readonly RuntimeLeafRecord[]

  /** A command finished with no launch held; an earlier mark (a nested shell's) or an agent typed
   *  at the prompt may have left an agent's exit unproven. Runs per mark, so indexed reads only. */
  protected noticeLaunchlessCommandMark(ptyId: string, confirmedExit: boolean | undefined): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty || !confirmedExit) {
      return
    }
    const recorded = pty.paneKey
    const paneKeys = new Set(recorded && parsePaneKey(recorded) ? [recorded] : [])
    for (const leaf of this.getLeavesForPty(ptyId)) {
      if (isValidTerminalTabId(leaf.tabId) && isTerminalLeafId(leaf.leafId)) {
        paneKeys.add(makePaneKey(leaf.tabId, leaf.leafId))
      }
    }
    for (const paneKey of paneKeys) {
      this.retireAgentHookCompatibilityAuthorityFn?.(paneKey, { launchRetired: true })
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

  /** Main's own attach of a surviving session (no pane mounted it, or no renderer at all) restores
   *  its launch exactly as a pane reattach does. Why the evidence gate: a launch this run already
   *  holds, or saw finish, must not be revived by a re-attach after an endpoint loss. */
  restoreAttachedLaunch(
    ptyId: string,
    attach: {
      incarnationId: PtyIncarnationId | undefined
      identity: ReattachedLaunchIdentity | null
      reattach: { launchNote?: DaemonLaunchNote | null } | undefined
    }
  ): void {
    const pty = this.ptysById.get(ptyId)
    if (
      !pty ||
      pty.launchAgent ||
      pty.launchToken ||
      (pty.launchEvidence && pty.launchEvidence.kind !== 'unknown')
    ) {
      return
    }
    this.restoreReattachedLaunch(pty, attach.incarnationId, attach.identity, attach.reattach)
  }

  /** Daemon metadata owns the surviving process: its incarnation fence restores the launched agent
   *  without minting launch authority, then the note main armed re-holds the launch. `reattach` is
   *  absent when the host attached nothing it could note. */
  protected restoreReattachedLaunch(
    pty: RuntimePtyWorktreeRecord,
    incarnationId: PtyIncarnationId | undefined,
    identity: ReattachedLaunchIdentity | null,
    reattach: { launchNote?: DaemonLaunchNote | null } | undefined
  ): void {
    let agent: TuiAgent | undefined
    // A null note is a launch main saw finish; the daemon's launch agent outlives it.
    if (
      reattach?.launchNote !== null &&
      identity &&
      pty.incarnationId === identity.incarnationId &&
      isTuiAgent(identity.launchAgent)
    ) {
      pty.launchAgent = agent = identity.launchAgent
    }
    // An older relay reports no incarnation; that still can't prove the launch gone.
    if (reattach && (pty.incarnationId ?? undefined) === incarnationId) {
      this.recordReattachedLaunch(pty, incarnationId, reattach.launchNote, agent)
    }
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
      if (pty.launchAgent === agent) {
        pty.launchAgent = null
      }
    } else if (foreground === 'agent' && pty.launchAgent === agent) {
      holdLaunch(pty, incarnationId, { agent, token: note.launchToken, config: note.launchConfig })
    }
  }
}
