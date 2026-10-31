import { resolveAgentStatusWorktreeId } from '../../shared/agent-status-worktree-attribution'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  agentPhaseTransition,
  hookRowAgentPhase,
  hookRowTransition,
  nextAgentPhase,
  titleAgentPhase,
  type AgentPhase,
  type AgentTransition
} from '../../shared/agent-transitions'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { AgentHookServer } from './server'

export type AgentTransitionStore = Pick<
  AgentHookServer,
  'getStatusSnapshot' | 'getStatusSnapshotForPane' | 'subscribeStatusRowMutations'
>

export type AgentPaneWorkspace = { worktreeId: string; sshHostId: ExecutionHostId | null }

export type AgentPaneChange =
  /** Existing status seeds observation without reporting a new transition. */
  | {
      kind: 'seeded'
      paneKey: string
      workspace: AgentPaneWorkspace
      phase: AgentPhase
      at: number
      /** An initial idle title may follow no turn at all. */
      fromTitle?: true
    }
  /** Emitted for every non-seeded hook observation, even without a phase change. */
  | {
      kind: 'observed'
      paneKey: string
      workspace: AgentPaneWorkspace | null
      phase: AgentPhase
      at: number
    }
  | {
      kind: 'moved'
      paneKey: string
      workspace: AgentPaneWorkspace
      from: AgentPhase
      to: AgentPhase
      at: number
      transition: AgentTransition | null
    }

type TrackedPane = { workspace: AgentPaneWorkspace; phase: AgentPhase }
type TitlePane = { ptyId: string; releaseExit: () => void }

export function agentPaneWorkspace(
  worktreeId: string,
  connectionId: string | null | undefined
): AgentPaneWorkspace {
  const hostId = getConnectionExecutionHostId(connectionId)
  return { worktreeId, sshHostId: hostId === LOCAL_EXECUTION_HOST_ID ? null : hostId }
}

export function sameAgentPaneWorkspace(
  a: AgentPaneWorkspace | null | undefined,
  b: AgentPaneWorkspace | null | undefined
): boolean {
  return !!a && !!b && a.worktreeId === b.worktreeId && a.sshHostId === b.sshHostId
}

/** Track one phase per pane, preferring hook rows over hookless-agent titles. */
export class AgentTransitionDetector {
  private readonly panes = new Map<string, TrackedPane>()
  // The first title for each PTY seeds state rather than reporting a transition.
  private readonly titlePanes = new Map<string, TitlePane>()
  private readonly listeners = new Set<(change: AgentPaneChange) => void>()
  private store: AgentTransitionStore | null = null

  constructor(
    private readonly deps: {
      resolveTabWorktreeId: (tabId: string) => string | undefined
      subscribeToPtyExit: (ptyId: string, listener: () => void) => () => void
      now: () => number
    }
  ) {}

  /** Subscribe before attach to receive its initial statuses. */
  subscribe(listener: (change: AgentPaneChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  attach(store: AgentTransitionStore): () => void {
    this.store = store
    for (const row of store.getStatusSnapshot()) {
      this.observe(row.paneKey, true)
    }
    const unsubscribe = store.subscribeStatusRowMutations(({ before, after }) => {
      for (const paneKey of new Set([before?.paneKey, after?.paneKey])) {
        if (paneKey) {
          this.observe(paneKey, false)
        }
      }
    })
    return () => {
      unsubscribe()
      this.store = null
    }
  }

  seedRestoredRows(): void {
    for (const row of this.store?.getStatusSnapshot() ?? []) {
      if (!this.panes.has(row.paneKey)) {
        this.observe(row.paneKey, true)
      }
    }
  }

  noteTerminalSideEffects(batch: TerminalSideEffectBatch): void {
    const { worktreeId, paneKey } = batch
    if (!worktreeId || !paneKey) {
      return
    }
    for (const fact of batch.facts) {
      if (fact.kind === 'title' && !this.latestRow(paneKey)) {
        // Timer-cleared titles do not prove turn completion.
        const phase = fact.staleWorkingTitleClear ? 'rest' : titleAgentPhase(fact.rawTitle)
        this.observeTitle(
          batch.ptyId,
          paneKey,
          agentPaneWorkspace(worktreeId, batch.connectionId),
          phase
        )
      }
    }
  }

  private observeTitle(
    ptyId: string,
    paneKey: string,
    workspace: AgentPaneWorkspace,
    phase: AgentPhase
  ): void {
    const known = this.titlePanes.get(paneKey)
    if (known?.ptyId === ptyId) {
      this.advance(paneKey, workspace, phase, this.deps.now(), agentPhaseTransition)
      return
    }
    // A new PTY replaces the pane's previous agent.
    if (known) {
      this.endTitlePane(paneKey)
    }
    let exited = false
    const releaseExit = this.deps.subscribeToPtyExit(ptyId, () => {
      exited = true
      this.endTitlePane(paneKey)
    })
    if (exited) {
      return
    }
    this.titlePanes.set(paneKey, { ptyId, releaseExit })
    const now = this.deps.now()
    // Publish departure before associating the pane with its new workspace.
    this.leaveIfMoved(paneKey, workspace, now)
    this.emit({ kind: 'seeded', paneKey, workspace, phase, at: now, fromTitle: true })
    this.track(paneKey, workspace, phase)
  }

  private endTitlePane(paneKey: string): void {
    this.titlePanes.get(paneKey)?.releaseExit()
    this.titlePanes.delete(paneKey)
    // Preserve hook-owned state after title tracking ends.
    if (!this.latestRow(paneKey)) {
      this.advance(paneKey, null, 'rest', this.deps.now(), () => null)
    }
  }

  private observe(paneKey: string, seed: boolean): void {
    const now = this.deps.now()
    const row = this.latestRow(paneKey)
    const worktreeId = row
      ? resolveAgentStatusWorktreeId(row, { get: this.deps.resolveTabWorktreeId })
      : undefined
    const workspace = row && worktreeId ? agentPaneWorkspace(worktreeId, row.connectionId) : null
    const observed = row ? hookRowAgentPhase(row) : 'rest'
    const restored = !!row && (seed || !!row.restoredUnconfirmed || !!row.isReplay)
    if (row && workspace && restored) {
      this.leaveIfMoved(paneKey, workspace, now)
      this.emit({ kind: 'seeded', paneKey, workspace, phase: observed, at: row.stateStartedAt })
      this.track(paneKey, workspace, observed)
      return
    }
    this.emit({ kind: 'observed', paneKey, workspace, phase: observed, at: now })
    this.advance(paneKey, row ? workspace : null, observed, now, (from, to) =>
      row ? hookRowTransition(from, to, row) : null
    )
  }

  private advance(
    paneKey: string,
    workspace: AgentPaneWorkspace | null,
    observed: AgentPhase,
    now: number,
    transitionOf: (from: AgentPhase, to: AgentPhase) => AgentTransition | null
  ): void {
    this.leaveIfMoved(paneKey, workspace, now)
    if (!workspace) {
      return
    }
    const from = this.panes.get(paneKey)?.phase ?? 'rest'
    const to = nextAgentPhase(from, observed)
    if (to === from) {
      return
    }
    this.track(paneKey, workspace, to)
    this.emit({
      kind: 'moved',
      paneKey,
      workspace,
      from,
      to,
      at: now,
      transition: transitionOf(from, to)
    })
  }

  private leaveIfMoved(paneKey: string, workspace: AgentPaneWorkspace | null, now: number): void {
    const previous = this.panes.get(paneKey)
    if (!previous || sameAgentPaneWorkspace(previous.workspace, workspace)) {
      return
    }
    this.panes.delete(paneKey)
    this.emit({
      kind: 'moved',
      paneKey,
      workspace: previous.workspace,
      from: previous.phase,
      to: 'rest',
      at: now,
      transition: null
    })
  }

  private track(paneKey: string, workspace: AgentPaneWorkspace, phase: AgentPhase): void {
    if (phase === 'rest') {
      this.panes.delete(paneKey)
    } else {
      this.panes.set(paneKey, { workspace, phase })
    }
  }

  phaseOf(paneKey: string): AgentPhase {
    return this.panes.get(paneKey)?.phase ?? 'rest'
  }

  /** Use the newest row to match the window's arrival-order projection. */
  latestRow(paneKey: string): AgentStatusIpcPayload | null {
    let latest: AgentStatusIpcPayload | null = null
    for (const row of this.store?.getStatusSnapshotForPane(paneKey) ?? []) {
      if (!row.providerSessionOnly && (!latest || row.receivedAt > latest.receivedAt)) {
        latest = row
      }
    }
    return latest
  }

  private emit(change: AgentPaneChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch (error) {
        console.error('[agent-transitions] listener threw', error)
      }
    }
  }
}
