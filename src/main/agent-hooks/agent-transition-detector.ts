import { resolveAgentStatusWorktreeId } from '../../shared/agent-status-worktree-attribution'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  hookRowAgentPhase,
  hookRowTransition,
  nextAgentPhase,
  type AgentPhase,
  type AgentTransition
} from '../../shared/agent-transitions'
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
  /** A status that predates this observer (restored, replayed, present at attach): never news. */
  | {
      kind: 'seeded'
      paneKey: string
      workspace: AgentPaneWorkspace
      phase: AgentPhase
      at: number
    }
  /** Every look not reported as seeded, changed or not; null: no row or no workspace. */
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
 * Per-pane agent transitions from the hook server's status store: prompt submitted, turn finished,
 * errored, needs input. Runs on every host; panes at rest are not kept.
 */
export class AgentTransitionDetector {
  private readonly panes = new Map<string, TrackedPane>()
  private readonly listeners = new Set<(change: AgentPaneChange) => void>()
  private store: AgentTransitionStore | null = null

  constructor(
    private readonly deps: {
      resolveTabWorktreeId: (tabId: string) => string | undefined
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

  /** Whether hooks report this pane, so its title is not read for status. */
  hasHookRow(paneKey: string): boolean {
    return this.latestRow(paneKey) !== null
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
      this.emit({ kind: 'seeded', paneKey, workspace, phase: observed, at: row.stateStartedAt })
    } else {
      this.emit({ kind: 'observed', paneKey, workspace, phase: observed, at: now })
    }
    const previous = this.panes.get(paneKey)
    if (previous && !sameAgentPaneWorkspace(previous.workspace, workspace)) {
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
    if (!row || !workspace) {
      return
    }
    if (restored) {
      this.track(paneKey, workspace, observed)
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
      transition: hookRowTransition(from, to, row)
    })
  }

  private track(paneKey: string, workspace: AgentPaneWorkspace, phase: AgentPhase): void {
    if (phase === 'rest') {
      this.panes.delete(paneKey)
    } else {
      this.panes.set(paneKey, { workspace, phase })
    }
  }

  // The window applies a pane's rows in arrival order, so the newest is the one it holds.
  private latestRow(paneKey: string): AgentStatusIpcPayload | null {
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
