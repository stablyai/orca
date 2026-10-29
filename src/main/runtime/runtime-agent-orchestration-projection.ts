import type { AgentStatusOrchestrationContext } from '../../shared/agent-status-types'
import type { FleetAgentStatusEvidence } from '../../shared/orchestration-fleet-agent-status-evidence'
import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration-task-display'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { OrchestrationCompatibilityTerminalAuthority } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { OrchestrationDb } from './orchestration/db'
import {
  buildWorkerAttentionContext,
  projectWorkerAttentionContext
} from './orchestration/worker-attention-context'
import { worktreeIdsEqual } from '../../shared/worktree/id'
import type { AgentSessionRecordReader } from './orchestration/structured-session-lineage'
import { createOrchestrationProjectionScope } from './runtime-agent-orchestration-scope'
import { isRecentPresentationDispatch } from './orchestration/db/dispatch-context/dispatch-lookup'
import { currentRunCoordinatorOrcaSessionId } from './orchestration/db/runs/run-coordinator-orca-session'
import type { DispatchContextRow } from './orchestration/types'
import type { PtyPaneOf } from './terminal/surface/pty-pane-query'

export type RuntimeAgentOrchestrationDependencies = {
  getDb(): OrchestrationDb | null
  getLeaves(): Iterable<RuntimeLeafRecord>
  getPtys(): Iterable<RuntimePtyWorktreeRecord>
  paneOf: PtyPaneOf
  issueLeafHandle(leaf: RuntimeLeafRecord): string
  issuePtyHandle(pty: RuntimePtyWorktreeRecord): string
  makePaneKey(leaf: RuntimeLeafRecord): string
  getWorktreeId(handle: string): string | null
  getHandleForPaneKey(paneKey: string): string | null
  getPaneKey(handle: string): string | null
  getDispatchAuthority(handle: string): OrchestrationCompatibilityTerminalAuthority | null
  getAgentStatusSnapshot(): readonly FleetAgentStatusEvidence[]
  getSessionRecords(): AgentSessionRecordReader | null
}

export class RuntimeAgentOrchestrationProjection {
  constructor(private readonly deps: RuntimeAgentOrchestrationDependencies) {}

  buildByPaneKey(): Record<string, AgentStatusOrchestrationContext> | undefined {
    const db = this.deps.getDb()
    if (!db || db.hasAnyDispatchContexts?.() === false) {
      return undefined
    }
    const scope = createOrchestrationProjectionScope(db, this.deps)
    const contexts: Record<string, AgentStatusOrchestrationContext> = {}
    const evidenceByPaneKey = new Map(
      this.deps.getAgentStatusSnapshot().map((evidence) => [evidence.activity.paneKey, evidence])
    )
    // Batch attention queries below; per-pane reads would repeat every 16ms publication.
    const batchAttention = typeof db.getWorkerAttentionFactsForDispatches === 'function'
    const queriedHandles = new Set<string>()
    for (const leaf of this.deps.getLeaves()) {
      if (!leaf.ptyId) {
        continue
      }
      const handle = this.deps.issueLeafHandle(leaf)
      queriedHandles.add(handle)
      const paneKey = this.deps.makePaneKey(leaf)
      const context = this.getForHandle(
        handle,
        db,
        {
          paneKey,
          evidence: evidenceByPaneKey.get(paneKey),
          deferAttention: batchAttention
        },
        scope
      )
      if (context) {
        contexts[paneKey] = context
      }
    }
    for (const pty of this.deps.getPtys()) {
      const { paneKey } = this.deps.paneOf(pty)
      if (!paneKey || contexts[paneKey]) {
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
        {
          paneKey,
          evidence: evidenceByPaneKey.get(paneKey),
          deferAttention: batchAttention
        },
        scope
      )
      if (context) {
        contexts[paneKey] = context
      }
    }
    for (const [paneKey, { dispatch }] of scope.sessionDispatches()) {
      if (!contexts[paneKey]) {
        contexts[paneKey] = this.projectDispatch(
          dispatch,
          dispatch.assignee_handle ?? '',
          db,
          {
            paneKey,
            evidence: evidenceByPaneKey.get(paneKey),
            deferAttention: batchAttention
          },
          scope
        )
      }
    }
    const entries = Object.entries(contexts)
    if (entries.length === 0) {
      return undefined
    }
    if (batchAttention) {
      const now = scope.now
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
    options: {
      // Handles are process-local; pane identity still names the Dispatch after restart.
      paneKey?: string
      evidence?: FleetAgentStatusEvidence
      deferAttention?: boolean
    } = {},
    scope = createOrchestrationProjectionScope(db, this.deps)
  ): AgentStatusOrchestrationContext | undefined {
    const { paneKey } = options
    const dispatch =
      db?.getActiveDispatchForTerminal?.(handle, paneKey) ?? this.getRecent(handle, db, scope.now)
    if (!dispatch) {
      return undefined
    }
    return this.projectDispatch(dispatch, handle, db, options, scope)
  }

  private projectDispatch(
    dispatch: DispatchContextRow,
    handle: string,
    db: OrchestrationDb | null,
    options: { paneKey?: string; evidence?: FleetAgentStatusEvidence; deferAttention?: boolean },
    scope: ReturnType<typeof createOrchestrationProjectionScope>
  ): AgentStatusOrchestrationContext {
    const { paneKey, evidence, deferAttention = false } = options
    const task = scope.task(dispatch.task_id, dispatch.run_id)
    const display =
      typeof task?.spec === 'string'
        ? buildOrchestrationTaskDisplayMetadata({
            spec: task.spec,
            taskTitle: task.task_title,
            displayName: task.display_name
          })
        : { taskTitle: '', displayName: '' }
    const owningRun =
      task?.run_id && task.run_id === dispatch.run_id ? scope.run(dispatch.run_id) : undefined
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
      worktreeIdsEqual(coordinatorWorktreeId, handleWorktreeId)
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
    const paneRun = creatorPaneKey ? scope.pane(creatorPaneKey) : undefined
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
      (paneKey !== undefined &&
        coordinator.paneKey !== undefined &&
        coordinator.paneKey === paneKey)
    // Why: a creator whose pane is gone still has a coordinator to nest under.
    const parent =
      (creator?.handle || (creatorSession && creator?.paneKey)) &&
      (!selfPane || creator?.paneKey !== selfPane) &&
      creator?.handle !== handle
        ? creator
        : coordinatorIsSelf
          ? {}
          : coordinator.paneKey === selfPane
            ? {}
            : coordinator
    const attention =
      !deferAttention && db && typeof db.getWorkerAttentionFacts === 'function'
        ? buildWorkerAttentionContext({ db, dispatch, task, evidence, now: scope.now })
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

  private getRecent(handle: string, db: OrchestrationDb | null, now: number) {
    const dispatch = db?.getLatestDispatchForTerminal?.(handle)
    return dispatch && isRecentPresentationDispatch(dispatch, now) ? dispatch : undefined
  }
}
