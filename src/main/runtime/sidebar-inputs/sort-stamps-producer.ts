import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { titleAgentPhase, type AgentPhase } from '../../../shared/agent-transitions'
import {
  classifySortStampEvent,
  isUnreadNews,
  nextAgentPaneState,
  REST_PANE,
  type AgentPaneState,
  type SortStampEvent
} from '../../../shared/sidebar-list/sort-stamps'
import type { TerminalSideEffectBatch } from '../../../shared/terminal-side-effect-facts'
import {
  agentPaneWorkspace,
  sameAgentPaneWorkspace,
  type AgentPaneChange,
  type AgentPaneWorkspace,
  type AgentTransitionDetector
} from '../../agent-hooks/agent-transition-detector'
import {
  listTieredWorkspaces,
  readSortStamps,
  writeSortStamps,
  writeUnreadFlag,
  type SortStampsStore
} from './sort-stamp-records'

export type { SortStampsStore } from './sort-stamp-records'

/** What the startup reconcile asks of the host, once its hook rows and PTYs have settled. */
export type StoredTierEvidence = {
  /** This machine's own workspace; unknown provenance is not local authority. */
  isLocalWorkspace: (worktreeId: string) => boolean
  /** Every PTY the workspace held: bound now, or persisted in its saved layout. */
  terminalPtyIds: (worktreeId: string) => readonly string[]
  /** True live, false absent, null when it cannot prove either. */
  probePtyLiveness: (ptyId: string) => Promise<boolean | null>
}

export type SortStampsSources = {
  store: () => SortStampsStore | null
  /** A WSL move freezes the project; stamps are background bookkeeping it drops. */
  isWriteFenced: (worktreeId: string) => boolean
  subscribeToPtyExit: (ptyId: string, listener: () => void) => () => void
  /** Consumes terminal side effects, so the host scans its own bytes for bells and titles. */
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: true }
  ) => () => void
  /** Whether a client is looking at the workspace, or at the pane's tab. */
  isViewing: (worktreeId: string, paneKey: string | null) => boolean
  /** A record's stamps or unread flag changed; clients re-list it. */
  onStampsWritten: (worktreeId: string) => void
  now: () => number
}

type TrackedPane = AgentPaneWorkspace & { state: AgentPaneState }
type TitlePane = { ptyId: string; releaseExit: () => void }

/**
 * Writes the sort stamps of every workspace this host owns, at the source: the transition
 * detector's hook panes (terminal agents and structured chats), hookless agents' titles, bells,
 * and terminals a CLI starts. Creation stamps itself where the record is made. Rest panes are not
 * kept. The same news raises the workspace's unread flag unless a client is looking at it; clients
 * clear it.
 */
export class SortStampsProducer {
  private readonly panes = new Map<string, TrackedPane>()
  /** Hookless panes seen since their PTY started: the first title seeds, it is not a transition. */
  private readonly titlePanes = new Map<string, TitlePane>()
  private transitions: AgentTransitionDetector | null = null

  constructor(private readonly sources: SortStampsSources) {
    sources.onClientEvent(
      (event) => {
        if (event.type === 'terminalSideEffects') {
          this.noteTerminalSideEffects(event.batch)
        }
      },
      { consumesTerminalSideEffects: true }
    )
  }

  /** Follows the detector's hook panes; subscribe before the detector attaches to its store. */
  attachAgentTransitions(transitions: AgentTransitionDetector): () => void {
    this.transitions = transitions
    const unsubscribe = transitions.subscribe((change) => this.applyHookPaneChange(change))
    return () => {
      unsubscribe()
      this.transitions = null
    }
  }

  /** A terminal started by something other than a person opening it. */
  noteTerminalStarted(worktreeId: string, hostId: ExecutionHostId | undefined): void {
    const sshHostId = parseExecutionHostId(hostId)?.kind === 'ssh' ? (hostId ?? null) : null
    this.stamp({ worktreeId, sshHostId }, { kind: 'terminal-started' })
  }

  /**
   * Clears a tier this machine stored that nothing backs after a restart: no hook row, and every
   * terminal it held proven gone by its provider. Runs once hook rows and PTYs have settled. Another
   * host's tiers stay: a host not reached yet is not one whose agents died.
   */
  async reconcileStoredTiers(evidence: StoredTierEvidence): Promise<void> {
    const probes = new Map<string, Promise<boolean>>()
    const isProvenAbsent = (ptyId: string): Promise<boolean> => {
      let probe = probes.get(ptyId)
      if (!probe) {
        // A probe that throws is unverifiable, never evidence the terminal died.
        probe = evidence.probePtyLiveness(ptyId).then(
          (live) => live === false,
          () => false
        )
        probes.set(ptyId, probe)
      }
      return probe
    }
    const candidates = listTieredWorkspaces(this.sources.store()).filter(
      (worktreeId) => evidence.isLocalWorkspace(worktreeId) && !this.isBacked(worktreeId)
    )
    await Promise.all(
      candidates.map(async (worktreeId) => {
        const ptyIds = evidence.terminalPtyIds(worktreeId)
        const absent = await Promise.all(ptyIds.map(isProvenAbsent))
        // No terminal on record proves nothing (a chat republishes later, a client owns the
        // layout); a pane can also report while the probes are in flight.
        if (ptyIds.length > 0 && absent.every(Boolean) && !this.isBacked(worktreeId)) {
          this.writeAgentChange({ worktreeId, sshHostId: null }, 'rest', 'rest', this.sources.now())
        }
      })
    )
  }

  private isBacked(worktreeId: string): boolean {
    for (const pane of this.panes.values()) {
      if (!pane.sshHostId && pane.worktreeId === worktreeId) {
        return true
      }
    }
    return false
  }

  // Observations, not transitions: the detector cannot see a title-tracked pane's phase.
  private applyHookPaneChange(change: AgentPaneChange): void {
    if (change.kind === 'seeded') {
      this.seed(change.paneKey, change.workspace, change.phase, change.at)
    } else if (change.kind === 'observed') {
      this.move(change.paneKey, change.workspace, change.phase, change.at)
    }
  }

  private noteTerminalSideEffects(batch: TerminalSideEffectBatch): void {
    const { worktreeId, paneKey } = batch
    if (!worktreeId) {
      return
    }
    const workspace = agentPaneWorkspace(worktreeId, batch.connectionId)
    for (const fact of batch.facts) {
      if (fact.kind === 'bell') {
        this.stamp(workspace, { kind: 'bell' }, this.sources.now(), paneKey ?? null)
      } else if (fact.kind === 'title' && paneKey && !this.transitions?.hasHookRow(paneKey)) {
        // Hook authority is per pane, as in Smart's attention. A cleared stale working title is a
        // timer's guess, not a finish.
        const phase = fact.staleWorkingTitleClear ? 'rest' : titleAgentPhase(fact.rawTitle)
        this.observeTitlePane(batch.ptyId, paneKey, workspace, phase)
      }
    }
  }

  private observeTitlePane(
    ptyId: string,
    paneKey: string,
    workspace: AgentPaneWorkspace,
    phase: AgentPhase
  ): void {
    const known = this.titlePanes.get(paneKey)
    if (known?.ptyId === ptyId) {
      this.move(paneKey, workspace, phase, this.sources.now())
      return
    }
    // A new PTY in the pane is a new agent; the last one left with its terminal.
    if (known) {
      this.endTitlePane(paneKey)
    }
    let exited = false
    const releaseExit = this.sources.subscribeToPtyExit(ptyId, () => {
      exited = true
      this.endTitlePane(paneKey)
    })
    if (exited) {
      return
    }
    this.titlePanes.set(paneKey, { ptyId, releaseExit })
    // An agent idle at its first title has finished no turn, unless the record says it had.
    const seeded =
      phase === 'done' && readSortStamps(this.sources.store(), workspace)?.smartTier !== 'done'
        ? 'rest'
        : phase
    this.seed(paneKey, workspace, seeded, this.sources.now())
  }

  private endTitlePane(paneKey: string): void {
    this.titlePanes.get(paneKey)?.releaseExit()
    this.titlePanes.delete(paneKey)
    this.move(paneKey, null, 'rest', this.sources.now())
  }

  /**
   * Takes the observed phase as it is and reconciles the tier, without a Recent stamp. A phase the
   * record already holds keeps its time, so a restart rewrites nothing.
   */
  private seed(
    paneKey: string,
    workspace: AgentPaneWorkspace | null,
    phase: AgentPhase,
    observedAt: number
  ): void {
    const previous = this.panes.get(paneKey)
    if (previous && !sameAgentPaneWorkspace(previous, workspace)) {
      this.move(paneKey, null, 'rest', this.sources.now())
    }
    if (!workspace) {
      return
    }
    const stored = readSortStamps(this.sources.store(), workspace)
    const state = {
      phase,
      at: stored?.smartTier === phase && stored.smartAt !== undefined ? stored.smartAt : observedAt
    }
    // A pane seeded at rest adds no tier; clearing one nothing backs is the reconcile's call.
    if (state.phase === 'rest') {
      if (this.panes.delete(paneKey)) {
        this.writeAgentChange(workspace, 'rest', 'rest', this.sources.now())
      }
      return
    }
    this.panes.set(paneKey, { ...workspace, state })
    this.writeAgentChange(workspace, state.phase, state.phase, this.sources.now())
  }

  /** One pane observed in `observed`; a pane that left or changed workspace rests where it was. */
  private move(
    paneKey: string,
    workspace: AgentPaneWorkspace | null,
    observed: AgentPhase,
    at: number
  ): void {
    const previous = this.panes.get(paneKey)
    if (previous && !sameAgentPaneWorkspace(previous, workspace)) {
      this.panes.delete(paneKey)
      this.writeAgentChange(previous, previous.state.phase, 'rest', at)
    }
    if (!workspace) {
      return
    }
    const before = sameAgentPaneWorkspace(previous, workspace) ? previous!.state : REST_PANE
    const state = nextAgentPaneState(before, observed, at)
    if (state === before) {
      return
    }
    if (state.phase === 'rest') {
      this.panes.delete(paneKey)
    } else {
      this.panes.set(paneKey, { ...workspace, state })
    }
    this.writeAgentChange(workspace, before.phase, state.phase, at, paneKey)
  }

  private writeAgentChange(
    workspace: AgentPaneWorkspace,
    from: AgentPhase,
    to: AgentPhase,
    now: number,
    paneKey: string | null = null
  ): void {
    const panes: AgentPaneState[] = []
    for (const pane of this.panes.values()) {
      if (sameAgentPaneWorkspace(pane, workspace)) {
        panes.push(pane.state)
      }
    }
    this.stamp(workspace, { kind: 'agent', from, to, panes }, now, paneKey)
  }

  // One clock read per event, so a pane's time and its Recent stamp agree.
  private stamp(
    workspace: AgentPaneWorkspace,
    event: SortStampEvent,
    now = this.sources.now(),
    paneKey: string | null = null
  ): void {
    // A WSL move only takes this machine's projects.
    if (!workspace.sshHostId && this.sources.isWriteFenced(workspace.worktreeId)) {
      return
    }
    const current = readSortStamps(this.sources.store(), workspace)
    const next = current && classifySortStampEvent(current, event, now)
    if (next) {
      writeSortStamps(this.sources.store(), workspace, next)
    }
    // Filters never gate this shared dot (clients' Filters differ); banners, sounds and pushes mute per surface.
    const raised =
      isUnreadNews(event) &&
      !this.sources.isViewing(workspace.worktreeId, paneKey) &&
      writeUnreadFlag(this.sources.store(), workspace, true)
    if (next || raised) {
      this.sources.onStampsWritten(workspace.worktreeId)
    }
  }
}
