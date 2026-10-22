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

/** The workspace a pane belongs to, qualified by the SSH host that runs it (null: this machine). */
export type AgentPaneWorkspace = { worktreeId: string; sshHostId: ExecutionHostId | null }

export type AgentPaneChange =
  /** A status that predates this observer (restored, replayed, present at attach, a hookless
   *  agent's first title): never news. */
  | {
      kind: 'seeded'
      paneKey: string
      workspace: AgentPaneWorkspace
      phase: AgentPhase
      at: number
      /** A first title: an idle one may follow no turn at all. */
      fromTitle?: true
    }
  /** Every hook look not reported as seeded, changed or not; null: no row or no workspace. */
  | {
      kind: 'observed'
      paneKey: string
      workspace: AgentPaneWorkspace | null
      phase: AgentPhase
      at: number
    }
  /** The pane changed phase at `at`; leaving a workspace rests the pane there. */
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

/**
 * Per-pane agent transitions from the hook server's status store, and from hookless agents' titles
 * where no hook row reports the pane: prompt submitted, turn finished, errored, needs input. One
 * phase per pane, so a title-tracked turn a hook row finishes is a finish. Runs on every host; panes
 * at rest are not kept.
 */
export class AgentTransitionDetector {
  private readonly panes = new Map<string, TrackedPane>()
  /** Hookless panes seen since their PTY started: the first title seeds, it is not a transition. */
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

  /** Subscribe before {@link attach}, or the statuses present at attach are missed. */
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

  /** Hydration fills the store without a row mutation; once it has, its rows seed here. */
  seedRestoredRows(): void {
    for (const row of this.store?.getStatusSnapshot() ?? []) {
      if (!this.panes.has(row.paneKey)) {
        this.observe(row.paneKey, true)
      }
    }
  }

  /** Hookless agents' titles. Hook authority is per pane, as in Smart's attention. */
  noteTerminalSideEffects(batch: TerminalSideEffectBatch): void {
    const { worktreeId, paneKey } = batch
    if (!worktreeId || !paneKey) {
      return
    }
    for (const fact of batch.facts) {
      if (fact.kind === 'title' && !this.latestRow(paneKey)) {
        // A cleared stale working title is a timer's guess, not a finish.
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
    // A new PTY in the pane is a new agent; the last one left with its terminal.
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
    // The pane leaves its old workspace first, so a reader never takes the leave for the new one.
    this.leaveIfMoved(paneKey, workspace, now)
    this.emit({ kind: 'seeded', paneKey, workspace, phase, at: now, fromTitle: true })
    this.track(paneKey, workspace, phase)
  }

  private endTitlePane(paneKey: string): void {
    this.titlePanes.get(paneKey)?.releaseExit()
    this.titlePanes.delete(paneKey)
    // A hook row that took the pane over still reports it.
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

  /** The pane observed in `observed`; a pane that left or changed workspace rests where it was. */
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

  /** The row the pane's phase reads. The window applies a pane's rows in arrival order, so the
   *  newest is the one it holds. */
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
      // One reader's failure must not cost the others the change.
      try {
        listener(change)
      } catch (error) {
        console.error('[agent-transitions] listener threw', error)
      }
    }
  }
}
