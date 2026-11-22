import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'
import type { DaemonLaunchNote } from '../../../daemon/protocol/daemon-launch-note-protocol'
import {
  readExactAgentForeground,
  type ExactAgentName,
  type LaunchedAgentForeground
} from '../wait/launched-agent-foreground'
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
    agent: TuiAgent,
    exact?: ExactAgentName
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
  ): Promise<void> | undefined {
    const pty = this.ptysById.get(ptyId)
    if (
      !pty ||
      pty.launchAgent ||
      pty.launchToken ||
      (pty.launchEvidence && pty.launchEvidence.kind !== 'unknown')
    ) {
      return undefined
    }
    return this.restoreReattachedLaunch(pty, attach.incarnationId, attach.identity, attach.reattach)
  }

  /** Daemon metadata names the agent launched in a surviving process, fenced to its incarnation; the
   *  note main armed re-holds that launch. Neither alone proves the agent still runs: the terminal
   *  may since run vim, ssh or another agent. `reattach` is absent when the host noted nothing. */
  protected restoreReattachedLaunch(
    pty: RuntimePtyWorktreeRecord,
    incarnationId: PtyIncarnationId | undefined,
    identity: ReattachedLaunchIdentity | null,
    reattach: { launchNote?: DaemonLaunchNote | null } | undefined
  ): Promise<void> | undefined {
    const fenced =
      identity && pty.incarnationId === identity.incarnationId && isTuiAgent(identity.launchAgent)
        ? identity
        : null
    let pending: LaunchEvidence | null = null
    // An older relay reports no incarnation; that still can't prove the launch gone.
    if (reattach && (pty.incarnationId ?? undefined) === incarnationId) {
      pending = recordReattachedLaunch(pty, incarnationId, reattach.launchNote)
    }
    if (!fenced || pty.launchToken) {
      return undefined
    }
    const note = pending ? (reattach?.launchNote ?? null) : null
    return this.confirmReattachedLaunch(pty, fenced, pty.launchEvidence, note)
  }

  /** Only the launched agent's own process in front restores it (and re-holds a noted launch). With
   *  no such proof (vim, ssh, another agent, an unreadable Windows/WSL/SSH foreground) the pane gets
   *  no launch agent, and its foreground name decides; a shell in front also retires the note. */
  private async confirmReattachedLaunch(
    pty: RuntimePtyWorktreeRecord,
    identity: ReattachedLaunchIdentity,
    evidence: LaunchEvidence | undefined,
    note: DaemonLaunchNote | null
  ): Promise<void> {
    const agent = identity.launchAgent
    const foreground = await readExactAgentForeground(
      this,
      this.ptyController,
      pty.ptyId,
      agent
    ).catch(() => 'unknown' as const)
    // Newer evidence (a later attach, a finished command, a fresh launch) outranks this read.
    if (
      pty.launchEvidence !== evidence ||
      this.ptysById.get(pty.ptyId) !== pty ||
      pty.incarnationId !== identity.incarnationId
    ) {
      return
    }
    if (foreground === 'agent') {
      pty.launchAgent ??= agent
      if (note && pty.launchAgent === agent) {
        holdLaunch(pty, identity.incarnationId, {
          agent,
          token: note.launchToken,
          config: note.launchConfig
        })
      }
      return
    }
    // An earlier attach may have restored it before the launch ended.
    if (pty.launchAgent === agent) {
      pty.launchAgent = null
    }
    if (foreground === 'shell' && note) {
      this.ptyController?.setLaunchNote?.(pty.ptyId, { retire: note.launchToken })
      retireLaunch(pty)
    }
  }
}
