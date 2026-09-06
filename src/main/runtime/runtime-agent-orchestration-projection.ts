import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusOrchestrationContext
} from '../../shared/agent-status-types'
import type { FleetAgentStatusEvidence } from '../../shared/orchestration-fleet-agent-status-evidence'
import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration-task-display'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { OrchestrationCompatibilityTerminalAuthority } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { OrchestrationDb } from './orchestration/db'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import {
  buildWorkerAttentionContext,
  projectWorkerAttentionContext
} from './orchestration/worker-attention-context'

type RuntimeAgentOrchestrationDependencies = {
  getDb(): OrchestrationDb | null
  getLeaves(): Iterable<RuntimeLeafRecord>
  getPtys(): Iterable<RuntimePtyWorktreeRecord>
  issueLeafHandle(leaf: RuntimeLeafRecord): string
  issuePtyHandle(pty: RuntimePtyWorktreeRecord): string
  makePaneKey(leaf: RuntimeLeafRecord): string
  getWorktreeId(handle: string): string | null
  getHandleForPaneKey(paneKey: string): string | null
  getPaneKey(handle: string): string | null
  getDispatchAuthority(handle: string): OrchestrationCompatibilityTerminalAuthority | null
  getAgentStatusSnapshot(): readonly FleetAgentStatusEvidence[]
}

export class RuntimeAgentOrchestrationProjection {
  constructor(private readonly deps: RuntimeAgentOrchestrationDependencies) {}

  buildByPaneKey(): Record<string, AgentStatusOrchestrationContext> | undefined {
    const db = this.deps.getDb()
    if (!db || db.hasAnyDispatchContexts?.() === false) {
      return undefined
    }
    const contexts: Record<string, AgentStatusOrchestrationContext> = {}
    const evidenceByPaneKey = new Map(
      this.deps.getAgentStatusSnapshot().map((evidence) => [evidence.activity.paneKey, evidence])
    )
    // Defer attention to one batched query below; per-pane facts would refetch on every 16ms publish.
    const batchAttention = typeof db.getWorkerAttentionFactsForDispatches === 'function'
    const queriedHandles = new Set<string>()
    for (const leaf of this.deps.getLeaves()) {
      if (!leaf.ptyId) {
        continue
      }
      const handle = this.deps.issueLeafHandle(leaf)
      queriedHandles.add(handle)
      const paneKey = this.deps.makePaneKey(leaf)
      const context = this.getForHandle(handle, db, evidenceByPaneKey.get(paneKey), batchAttention)
      if (context) {
        contexts[paneKey] = context
      }
    }
    for (const pty of this.deps.getPtys()) {
      if (!pty.paneKey || contexts[pty.paneKey]) {
        continue
      }
      const handle = this.deps.issuePtyHandle(pty)
      if (queriedHandles.has(handle)) {
        continue
      }
      queriedHandles.add(handle)
      const context = this.getForHandle(
        handle,
        db,
        evidenceByPaneKey.get(pty.paneKey),
        batchAttention
      )
      if (context) {
        contexts[pty.paneKey] = context
      }
    }
    const entries = Object.entries(contexts)
    if (entries.length === 0) {
      return undefined
    }
    if (batchAttention) {
      const now = Date.now()
      const factsByDispatch = db.getWorkerAttentionFactsForDispatches(
        entries.map(([, context]) => context.dispatchId),
        now
      )
      for (const [paneKey, context] of entries) {
        const facts = factsByDispatch.get(context.dispatchId)
        if (facts) {
          contexts[paneKey] = {
            ...context,
            attention: projectWorkerAttentionContext({
              facts,
              isRoot: facts.isRoot,
              evidence: evidenceByPaneKey.get(paneKey),
              now
            })
          }
        }
      }
    }
    return contexts
  }

  getForHandle(
    handle: string,
    db = this.deps.getDb(),
    evidence?: FleetAgentStatusEvidence,
    deferAttention = false
  ): AgentStatusOrchestrationContext | undefined {
    const dispatch = db?.getActiveDispatchForTerminal?.(handle) ?? this.getRecent(handle, db)
    if (!dispatch) {
      return undefined
    }
    const task = db?.getTask?.(dispatch.task_id, dispatch.run_id)
    const display =
      typeof task?.spec === 'string'
        ? buildOrchestrationTaskDisplayMetadata({
            spec: task.spec,
            taskTitle: task.task_title,
            displayName: task.display_name
          })
        : { taskTitle: '', displayName: '' }
    const owningRun =
      task?.run_id && task.run_id === dispatch.run_id ? db?.getRun?.(dispatch.run_id) : undefined
    const runCoordinatorHandle = owningRun?.coordinator_handle ?? undefined
    const legacyActiveRun =
      owningRun?.legacy === 1 && (dispatch.status === 'pending' || dispatch.status === 'dispatched')
        ? db?.getActiveCoordinatorRun?.()
        : undefined
    const handleWorktreeId = legacyActiveRun ? this.deps.getWorktreeId(handle) : null
    const coordinatorWorktreeId = legacyActiveRun
      ? this.deps.getWorktreeId(legacyActiveRun.coordinator_handle)
      : null
    const scopedLegacyRun =
      legacyActiveRun &&
      handleWorktreeId &&
      coordinatorWorktreeId &&
      runtimeWorktreeIdsEqual(coordinatorWorktreeId, handleWorktreeId)
        ? legacyActiveRun
        : undefined
    const coordinatorHandle = runCoordinatorHandle ?? scopedLegacyRun?.coordinator_handle
    const orchestrationRunId = owningRun?.legacy === 0 ? owningRun.id : scopedLegacyRun?.id
    const creatorPaneKey = task?.created_by_pane_key
    const creatorPaneHandle = creatorPaneKey ? this.deps.getHandleForPaneKey(creatorPaneKey) : null
    const creatorAuthority = creatorPaneHandle
      ? this.deps.getDispatchAuthority(creatorPaneHandle)
      : null
    const storedCreatorPane = creatorPaneKey ? parsePaneKey(creatorPaneKey) : null
    const currentCreatorPane = creatorAuthority?.paneKey
      ? parsePaneKey(creatorAuthority.paneKey)
      : null
    const sameCreatorPane = Boolean(
      creatorPaneKey &&
      creatorAuthority?.paneKey &&
      (creatorPaneKey === creatorAuthority.paneKey ||
        (storedCreatorPane &&
          currentCreatorPane &&
          storedCreatorPane.leafId === currentCreatorPane.leafId))
    )
    const paneRun = creatorPaneKey ? db?.getCurrentRunForPane?.(creatorPaneKey) : undefined
    const sameRunCreatorDispatch = Boolean(
      task?.creator_dispatch_id &&
      task.creator_dispatch_run_id === owningRun?.id &&
      task.creator_dispatch_pane_key &&
      task.creator_dispatch_process_incarnation === task.created_by_process_incarnation &&
      parsePaneKey(task.creator_dispatch_pane_key)?.leafId === storedCreatorPane?.leafId
    )
    const currentCreatorHandle =
      owningRun?.legacy === 0 &&
      task?.created_by_run_generation === owningRun.consumer_generation &&
      task.created_by_process_incarnation === creatorAuthority?.processIncarnation &&
      sameCreatorPane &&
      (paneRun
        ? paneRun.id === owningRun.id &&
          paneRun.consumer_generation === task.created_by_run_generation
        : sameRunCreatorDispatch)
        ? (creatorPaneHandle ?? undefined)
        : undefined
    const parentHandle =
      currentCreatorHandle ??
      (coordinatorHandle && coordinatorHandle !== handle ? coordinatorHandle : undefined)
    const parentPaneKey = parentHandle ? this.deps.getPaneKey(parentHandle) : undefined
    const attention =
      !deferAttention && db && typeof db.getWorkerAttentionFacts === 'function'
        ? buildWorkerAttentionContext({ db, dispatch, task, evidence })
        : undefined
    return {
      taskId: dispatch.task_id,
      dispatchId: dispatch.id,
      dispatchStatus: dispatch.status,
      ...(display.taskTitle ? { taskTitle: display.taskTitle } : {}),
      ...(display.displayName ? { displayName: display.displayName } : {}),
      ...(parentHandle ? { parentTerminalHandle: parentHandle } : {}),
      ...(parentPaneKey ? { parentPaneKey } : {}),
      ...(coordinatorHandle ? { coordinatorHandle } : {}),
      ...(orchestrationRunId ? { orchestrationRunId } : {}),
      ...(attention ? { attention } : {})
    }
  }

  private getRecent(handle: string, db: OrchestrationDb | null) {
    const dispatch = db?.getLatestDispatchForTerminal?.(handle)
    if (
      !dispatch?.completed_at ||
      dispatch.status === 'pending' ||
      dispatch.status === 'dispatched'
    ) {
      return undefined
    }
    const completedAt = Date.parse(
      dispatch.completed_at.includes('T')
        ? dispatch.completed_at
        : `${dispatch.completed_at.replace(' ', 'T')}Z`
    )
    return Number.isFinite(completedAt) && Date.now() - completedAt <= AGENT_STATUS_STALE_AFTER_MS
      ? dispatch
      : undefined
  }
}
