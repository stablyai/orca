import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { AgentPhase, AgentTransition } from '../../../shared/agent-transitions'
import {
  classifySortStampEvent,
  enterAgentPaneState,
  isUnreadNews,
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
  readWorkspaceRecord,
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
  /** Consumes terminal side effects, so the host scans its own bytes for bells. */
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
/** A tier reconciled without a pane moving. */
const SETTLED = { from: 'rest', to: 'rest', transition: null } as const

/**
 * Writes the sort stamps of every workspace this host owns, at the source: the transition
 * detector's agent panes (terminal agents, structured chats, hookless agents' titles), bells, and
 * terminals a CLI starts. Creation stamps itself where the record is made. Rest panes are not
 * kept. The detector's news raises the workspace's unread flag unless a client is looking at it;
 * clients clear it.
 */
export class SortStampsProducer {
  private readonly panes = new Map<string, TrackedPane>()

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

  /** Follows the detector's panes; subscribe before the detector attaches to its store. */
  attachAgentTransitions(transitions: AgentTransitionDetector): () => void {
    return transitions.subscribe((change) => this.applyPaneChange(change))
  }

  /** A terminal started by something other than a person opening it. */
  noteTerminalStarted(worktreeId: string, hostId: ExecutionHostId | undefined): void {
    const sshHostId = parseExecutionHostId(hostId)?.kind === 'ssh' ? (hostId ?? null) : null
    this.stamp({ worktreeId, sshHostId }, { kind: 'terminal-started' })
  }

  /** A record write may have moved an unread flag; a Done beside a Working pane re-tiers on it. */
  noteRecordsWritten(): void {
    const phasesByWorkspace = new Map<string, { workspace: TrackedPane; phases: Set<AgentPhase> }>()
    for (const pane of this.panes.values()) {
      const key = `${pane.sshHostId ?? ''}|${pane.worktreeId}`
      const entry = phasesByWorkspace.get(key) ?? { workspace: pane, phases: new Set() }
      entry.phases.add(pane.state.phase)
      phasesByWorkspace.set(key, entry)
    }
    for (const { workspace, phases } of phasesByWorkspace.values()) {
      if (phases.has('done') && phases.has('working')) {
        this.writeAgentChange(workspace, SETTLED, this.sources.now())
      }
    }
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
          this.writeAgentChange({ worktreeId, sshHostId: null }, SETTLED, this.sources.now())
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

  private applyPaneChange(change: AgentPaneChange): void {
    if (change.kind === 'seeded') {
      // An agent idle at its first title has finished no turn, unless the record says it had.
      const phase =
        change.fromTitle &&
        change.phase === 'done' &&
        readSortStamps(this.sources.store(), change.workspace)?.smartTier !== 'done'
          ? 'rest'
          : change.phase
      this.seed(change.paneKey, change.workspace, phase, change.at)
    } else if (change.kind === 'moved') {
      this.applyMove(change)
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
      }
    }
  }

  /**
   * Takes the observed phase as it is and reconciles the tier, without a Recent stamp. A phase the
   * record already holds keeps its time, so a restart rewrites nothing.
   */
  private seed(
    paneKey: string,
    workspace: AgentPaneWorkspace,
    phase: AgentPhase,
    observedAt: number
  ): void {
    const stored = readSortStamps(this.sources.store(), workspace)
    const state = {
      phase,
      at: stored?.smartTier === phase && stored.smartAt !== undefined ? stored.smartAt : observedAt
    }
    // A pane seeded at rest adds no tier; clearing one nothing backs is the reconcile's call.
    if (state.phase === 'rest') {
      if (this.panes.delete(paneKey)) {
        this.writeAgentChange(workspace, SETTLED, this.sources.now())
      }
      return
    }
    this.panes.set(paneKey, { ...workspace, state })
    this.writeAgentChange(
      workspace,
      { from: state.phase, to: state.phase, transition: null },
      this.sources.now()
    )
  }

  /** The detector moved one pane; the tier takes its phase as given. */
  private applyMove(change: Extract<AgentPaneChange, { kind: 'moved' }>): void {
    const { paneKey, workspace, from, to, at, transition } = change
    const state = enterAgentPaneState(this.panes.get(paneKey)?.state ?? REST_PANE, to, at)
    if (state.phase === 'rest') {
      this.panes.delete(paneKey)
    } else {
      this.panes.set(paneKey, { ...workspace, state })
    }
    this.writeAgentChange(workspace, { from, to, transition }, at, paneKey)
  }

  private writeAgentChange(
    workspace: AgentPaneWorkspace,
    change: { from: AgentPhase; to: AgentPhase; transition: AgentTransition | null },
    now: number,
    paneKey: string | null = null
  ): void {
    const panes: AgentPaneState[] = []
    for (const pane of this.panes.values()) {
      if (sameAgentPaneWorkspace(pane, workspace)) {
        panes.push(pane.state)
      }
    }
    this.stamp(workspace, { kind: 'agent', ...change, panes }, now, paneKey)
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
    // Filters never gate this shared dot (clients' Filters differ); banners, sounds and pushes mute per surface.
    const raised =
      isUnreadNews(event) &&
      !this.sources.isViewing(workspace.worktreeId, paneKey) &&
      writeUnreadFlag(this.sources.store(), workspace, true)
    // After the raise: whether Done outranks Working depends on the flag this event leaves.
    const isUnread = readWorkspaceRecord(this.sources.store(), workspace)?.isUnread === true
    const current = readSortStamps(this.sources.store(), workspace)
    const next = current && classifySortStampEvent(current, event, now, isUnread)
    if (next) {
      writeSortStamps(this.sources.store(), workspace, next)
    }
    if (next || raised) {
      this.sources.onStampsWritten(workspace.worktreeId)
    }
  }
}
