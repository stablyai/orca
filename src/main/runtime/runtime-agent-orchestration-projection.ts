import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusOrchestrationContext
} from '../../shared/agent-status-types'
import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration-task-display'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { OrchestrationCompatibilityTerminalAuthority } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { OrchestrationDb } from './orchestration/db'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'

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
}

export class RuntimeAgentOrchestrationProjection {
  constructor(private readonly deps: RuntimeAgentOrchestrationDependencies) {}

  buildByPaneKey(): Record<string, AgentStatusOrchestrationContext> | undefined {
    const db = this.deps.getDb()
    if (!db || db.hasAnyDispatchContexts?.() === false) {
      return undefined
    }
    const contexts: Record<string, AgentStatusOrchestrationContext> = {}
    const queriedHandles = new Set<string>()
    for (const leaf of this.deps.getLeaves()) {
      if (!leaf.ptyId) {
        continue
      }
      const handle = this.deps.issueLeafHandle(leaf)
      queriedHandles.add(handle)
      const context = this.getForHandle(handle, db)
      if (context) {
        contexts[this.deps.makePaneKey(leaf)] = context
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
      const context = this.getForHandle(handle, db)
      if (context) {
        contexts[pty.paneKey] = context
      }
    }
    return Object.keys(contexts).length > 0 ? contexts : undefined
  }

  getForHandle(
    handle: string,
    db = this.deps.getDb()
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
    return {
      taskId: dispatch.task_id,
      dispatchId: dispatch.id,
      dispatchStatus: dispatch.status,
      ...(display.taskTitle ? { taskTitle: display.taskTitle } : {}),
      ...(display.displayName ? { displayName: display.displayName } : {}),
      ...(parentHandle ? { parentTerminalHandle: parentHandle } : {}),
      ...(parentPaneKey ? { parentPaneKey } : {}),
      ...(coordinatorHandle ? { coordinatorHandle } : {}),
      ...(orchestrationRunId ? { orchestrationRunId } : {})
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
