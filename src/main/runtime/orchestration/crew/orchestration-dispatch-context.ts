import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import { creatorFirstParent, crewTaskDisplay } from './crew-rules'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { OrchestrationDb } from '../db/orchestration-db'
import { buildWorkerAttentionContext } from '../workers/reports/worker-attention-context'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import type { createOrchestrationProjectionScope } from './runtime-agent-orchestration-scope'
import { currentRunCoordinatorOrcaSessionId } from '../db/runs/run-coordinator-orca-session'
import type { DispatchContextRow } from '../db/orchestration-records'
import type {
  DispatchProjectionOptions,
  RuntimeAgentOrchestrationDependencies
} from './runtime-agent-orchestration-projection'

export function composeOrchestrationDispatch(
  deps: RuntimeAgentOrchestrationDependencies,
  dispatch: DispatchContextRow,
  handle: string,
  db: OrchestrationDb | null,
  options: DispatchProjectionOptions,
  scope: ReturnType<typeof createOrchestrationProjectionScope>
): AgentStatusOrchestrationContext {
  const { paneKey, evidence, deferAttention = false } = options
  const session = options.observeSession?.(dispatch)
  const task = scope.task(dispatch.task_id, dispatch.run_id)
  const display = crewTaskDisplay(task)
  const owningRun =
    task?.run_id && task.run_id === dispatch.run_id ? scope.run(dispatch.run_id) : undefined
  const runCoordinatorHandle = owningRun?.coordinator_handle ?? undefined
  const legacyActiveRun =
    owningRun?.legacy === 1 && (dispatch.status === 'pending' || dispatch.status === 'dispatched')
      ? db?.getActiveCoordinatorRun?.()
      : undefined
  const handleWorktreeId = legacyActiveRun ? deps.getWorktreeId(handle) : null
  const coordinatorWorktreeId = legacyActiveRun
    ? deps.getWorktreeId(legacyActiveRun.coordinator_handle)
    : null
  const scopedLegacyRun =
    legacyActiveRun &&
    handleWorktreeId &&
    coordinatorWorktreeId &&
    worktreeIdsEqual(coordinatorWorktreeId, handleWorktreeId)
      ? legacyActiveRun
      : undefined
  const coordinatorHandle = runCoordinatorHandle ?? scopedLegacyRun?.coordinator_handle
  const orchestrationRunId = owningRun?.legacy === 0 ? owningRun.id : scopedLegacyRun?.id
  const creatorPaneKey = task?.created_by_pane_key
  const creatorPaneHandle = creatorPaneKey ? deps.getHandleForPaneKey(creatorPaneKey) : null
  const creatorAuthority = creatorPaneHandle ? deps.getDispatchAuthority(creatorPaneHandle) : null
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
  const paneRuns = creatorPaneKey ? scope.paneRuns(creatorPaneKey) : []
  const paneRun = paneRuns.find((run) => run.id === owningRun?.id) ?? paneRuns[0]
  const sameRunCreatorDispatch = Boolean(
    task?.creator_dispatch_id &&
    task.creator_dispatch_run_id === owningRun?.id &&
    task.creator_dispatch_pane_key &&
    task.creator_dispatch_process_incarnation === task.created_by_process_incarnation &&
    parsePaneKey(task.creator_dispatch_pane_key)?.leafId === storedCreatorPane?.leafId
  )
  // Durable Run membership identifies the creator; live incarnation/handle checks only decide mutation authority.
  const creatorLineageInRun = Boolean(
    owningRun?.legacy === 0 &&
    task?.created_by_run_generation === owningRun.consumer_generation &&
    creatorPaneKey &&
    (paneRun
      ? paneRun.id === owningRun.id &&
        paneRun.consumer_generation === task.created_by_run_generation
      : sameRunCreatorDispatch)
  )
  const currentCreatorHandle =
    creatorLineageInRun &&
    task?.created_by_process_incarnation === creatorAuthority?.processIncarnation &&
    sameCreatorPane
      ? (creatorPaneHandle ?? undefined)
      : undefined
  const selfSession = dispatch.assignee_orca_session_id
  const selfPane = selfSession ? scope.resolve(selfSession) : paneKey
  const coordinatorSession =
    owningRun?.legacy === 0 ? currentRunCoordinatorOrcaSessionId(owningRun) : null
  // Why: a chat party nests by its visible row; its handle and minted pane key match no row.
  const coordinator: { handle?: string; paneKey?: string } = coordinatorSession
    ? { paneKey: scope.resolve(coordinatorSession) }
    : scope.resolveTerminal(
        coordinatorHandle,
        owningRun?.legacy === 0 ? owningRun.coordinator_pane_key : null
      )
  const creatorSession =
    dispatch.creator_orca_session_id && dispatch.creator_orca_session_id !== selfSession
      ? dispatch.creator_orca_session_id
      : null
  const creator: { handle?: string; paneKey?: string } | undefined = creatorSession
    ? { paneKey: scope.resolve(creatorSession) }
    : currentCreatorHandle
      ? scope.resolveTerminal(currentCreatorHandle, creatorAuthority?.paneKey ?? null)
      : creatorLineageInRun
        ? scope.resolveTerminal(creatorPaneHandle, creatorPaneKey ?? null)
        : undefined
  const coordinatorIsSelf =
    coordinator.handle === handle ||
    (coordinatorSession !== null && coordinatorSession === selfSession) ||
    (paneKey !== undefined && coordinator.paneKey !== undefined && coordinator.paneKey === paneKey)
  // Why: a creator whose pane is gone still has a coordinator to nest under.
  const parent =
    creatorFirstParent(
      (creator?.handle || (creatorSession && creator?.paneKey)) &&
        (!selfPane || creator?.paneKey !== selfPane) &&
        creator?.handle !== handle
        ? creator
        : undefined,
      coordinator,
      coordinatorIsSelf || coordinator.paneKey === selfPane
    ) ?? {}
  const attention =
    !deferAttention && db && typeof db.getWorkerAttentionFacts === 'function'
      ? buildWorkerAttentionContext({ db, dispatch, task, evidence, session, now: scope.now })
      : undefined
  return {
    taskId: dispatch.task_id,
    dispatchId: dispatch.id,
    dispatchStatus: dispatch.status,
    ...(display.taskTitle ? { taskTitle: display.taskTitle } : {}),
    ...(display.displayName ? { displayName: display.displayName } : {}),
    ...(parent.handle ? { parentTerminalHandle: parent.handle } : {}),
    ...(parent.paneKey ? { parentPaneKey: parent.paneKey } : {}),
    ...(coordinator.handle ? { coordinatorHandle: coordinator.handle } : {}),
    ...(orchestrationRunId ? { orchestrationRunId } : {}),
    ...(attention ? { attention } : {})
  }
}
