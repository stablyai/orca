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
  private readonly paneLaunchRestores = new WeakMap<RuntimePtyWorktreeRecord, Promise<void>>()

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
    // A pane's own restore decides; superseding it would drop the agent it may restore unread.
    const paneRestore = pty && this.paneLaunchRestores.get(pty)
    if (paneRestore) {
      return paneRestore
    }
    if (
      !pty ||
      pty.launchAgent ||
      pty.launchToken ||
      (pty.launchEvidence && pty.launchEvidence.kind !== 'unknown')
    ) {
      return undefined
    }
    // Main's attach never restored an agent it can't see in front; an unreadable foreground keeps that.
    return this.restoreReattachedLaunch(
      pty,
      attach.incarnationId,
      attach.identity,
      attach.reattach,
      false
    )
  }

  /** Daemon metadata names the agent launched in a surviving process, fenced to its incarnation; the
   *  note main armed re-holds that launch. Neither alone proves the agent still runs: the terminal
   *  may since run vim, ssh or another agent. `reattach` is absent when the host noted nothing.
   *  `trustUnread`: where the foreground can't be read, take the daemon's name, as a pane reattach
   *  always has. */
  protected restoreReattachedLaunch(
    pty: RuntimePtyWorktreeRecord,
    incarnationId: PtyIncarnationId | undefined,
    identity: ReattachedLaunchIdentity | null,
    reattach: { launchNote?: DaemonLaunchNote | null } | undefined,
    trustUnread: boolean
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
    // An older local owner can only list every session per read, so its foreground counts as unread.
    if (!pty.connectionId && !this.ptyController?.supportsForegroundObservation?.(pty.ptyId)) {
      if (trustUnread) {
        this.restoreLaunchAgent(pty, fenced.launchAgent)
      }
      return undefined
    }
    const note = pending ? (reattach?.launchNote ?? null) : null
    const restore = this.confirmReattachedLaunch(pty, fenced, pty.launchEvidence, note, trustUnread)
    if (trustUnread) {
      this.paneLaunchRestores.set(pty, restore)
      void restore.finally(() => {
        if (this.paneLaunchRestores.get(pty) === restore) {
          this.paneLaunchRestores.delete(pty)
        }
      })
    }
    return restore
  }

  private restoreLaunchAgent(pty: RuntimePtyWorktreeRecord, agent: TuiAgent): void {
    if (!pty.launchAgent) {
      pty.launchAgent = agent
      this.touchMobileSessionSnapshotsForPty(pty.ptyId)
    }
  }

  /** The launched agent's own process in front restores it and re-holds a noted launch; another
   *  program in front (vim, ssh, another agent) restores nothing, so its foreground name decides. An
   *  unreadable foreground (Windows, WSL, older SSH relays) proves neither: `trustUnread` restores the
   *  agent without holding the note. Only a shell in front undoes an earlier restore, and retires the note. */
  private async confirmReattachedLaunch(
    pty: RuntimePtyWorktreeRecord,
    identity: ReattachedLaunchIdentity,
    evidence: LaunchEvidence | undefined,
    note: DaemonLaunchNote | null,
    trustUnread: boolean
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
    if (foreground === 'unknown' && trustUnread) {
      this.restoreLaunchAgent(pty, agent)
      return
    }
    if (foreground === 'agent') {
      this.restoreLaunchAgent(pty, agent)
      if (note && pty.launchAgent === agent) {
        holdLaunch(pty, identity.incarnationId, {
          agent,
          token: note.launchToken,
          config: note.launchConfig
        })
      }
      return
    }
    if (foreground !== 'shell') {
      return
    }
    // An earlier attach may have restored it before the launch ended.
    if (pty.launchAgent === agent) {
      pty.launchAgent = null
      this.touchMobileSessionSnapshotsForPty(pty.ptyId)
    }
    if (note) {
      this.ptyController?.setLaunchNote?.(pty.ptyId, { retire: note.launchToken })
      retireLaunch(pty)
    }
  }
}
