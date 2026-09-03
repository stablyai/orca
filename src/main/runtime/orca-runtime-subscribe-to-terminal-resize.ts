// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithApplyMobileDisplayMode } from './orca-runtime-apply-mobile-display-mode'
import { addListenerToMap } from './orca-runtime-core'
import { notifyRuntimeListeners, withTimeoutResult } from './runtime-async-boundaries'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import {
  describeTerminalExitCause,
  isDeliberateTerminalExit
} from '../../shared/terminal-exit-cause'
import {
  DEFAULT_TERMINAL_LIST_LIMIT,
  PTY_CONTROLLER_LIST_TIMEOUT_MS
} from './orca-runtime-postlude'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult
} from '../../shared/runtime-types'
import {
  classifyWorkerTerminalProcessIncarnation,
  parseWorkerTerminalHostScope
} from './orchestration/worker-terminal-process-liveness'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration-task-display'

export class OrcaRuntimeWithSubscribeToTerminalResize extends OrcaRuntimeWithApplyMobileDisplayMode {
  subscribeToTerminalResize(
    ptyId: string,
    listener: (event: {
      cols: number
      rows: number
      displayMode: string
      reason: string
      seq?: number
    }) => void
  ): () => void {
    return addListenerToMap(this.resizeListeners, ptyId, listener)
  }

  protected notifyTerminalResize(
    ptyId: string,
    event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
  ): void {
    const listeners = this.resizeListeners.get(ptyId)
    if (!listeners) {
      return
    }
    notifyRuntimeListeners(listeners, (listener) => listener(event), 'pty-resize')
  }

  // Why: Section 7.2 — the runtime detects agent exit directly and updates
  // dispatch contexts immediately, rather than waiting for the coordinator's
  // next poll cycle. This catches agent crashes and unexpected exits within
  // milliseconds. The task is set back to 'pending' so it can be re-dispatched.
  protected failActiveDispatchOnExit(
    handle: string,
    paneKey: string | null,
    exitCode: number,
    cause: TerminalExitCause,
    processIncarnation: string | null,
    processDeathCertified: boolean
  ): void {
    if (!this._orchestrationDb) {
      return
    }

    // Why the pane key too: a reminted handle no longer matches the row, but the
    // pane identity behind it outlives the remint.
    const dispatch = this._orchestrationDb.getActiveDispatchForTerminal(
      handle,
      paneKey ?? undefined
    )
    if (!dispatch) {
      return
    }

    // A proven exit for this stop intent wins over the close promise's later settlement.
    if (
      cause.kind === 'operator_close' &&
      processDeathCertified &&
      this._orchestrationDb.getWorkerDispatch(dispatch.id)?.state === 'stopping' &&
      this._orchestrationDb.isDispatchProcessCurrent({
        dispatchId: dispatch.id,
        paneKey,
        processIncarnation
      })
    ) {
      this._orchestrationDb.settleWorkerStop(dispatch.id)
      return
    }

    const errorContext = describeTerminalExitCause(cause)
    const settled = this._orchestrationDb.failDispatch(dispatch.id, errorContext, {
      workerProcessExited: true,
      terminationReason: cause.kind
    })
    if (isDeliberateTerminalExit(cause)) {
      return
    }

    // Why: create an escalation message so the coordinator is notified about
    // the unexpected exit on its next check cycle, even if the circuit breaker
    // hasn't tripped yet.
    try {
      const owningRun = this._orchestrationDb.getRun?.(dispatch.run_id)
      const active = this._orchestrationDb.getActiveCoordinatorRun?.()
      const recipient =
        owningRun && owningRun.legacy !== 1
          ? { to: `run:${owningRun.id}`, runId: owningRun.id }
          : active
            ? { to: active.coordinator_handle, runId: undefined }
            : null
      if (!recipient) {
        return
      }
      const task = this._orchestrationDb.getTask?.(dispatch.task_id, dispatch.run_id)
      // Why: prefer the explicit task title and keep the derived one single-line and bounded;
      // a raw multi-paragraph spec inlined here breaks the coordinator's escalation banner.
      const title =
        typeof task?.spec === 'string'
          ? buildOrchestrationTaskDisplayMetadata({
              spec: task.spec,
              taskTitle: task.task_title,
              displayName: task.display_name
            }).taskTitle
          : ''
      const named = title ? `"${title}" (${dispatch.task_id})` : dispatch.task_id
      const escalation = this._orchestrationDb.insertMessage({
        from: handle,
        to: recipient.to,
        subject: `Agent exited unexpectedly (${errorContext})`,
        body: `Worker ${handle} stopped while running task ${named}. ${errorContext}.${settled?.status === 'circuit_broken' ? ' This task has now failed too many times, so it will not be retried automatically.' : settled?.status === 'failed' ? ' The task is ready to be dispatched again.' : ''}`,
        type: 'escalation',
        priority: 'high',
        payload: JSON.stringify({
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          exitCode,
          exitCause: cause,
          handle
        }),
        ...(recipient.runId ? { runId: recipient.runId } : {})
      })
      this.notifyMessageArrived(escalation.to_handle, escalation.type)
    } catch (error) {
      console.warn('[orchestration] failed to escalate worker exit', {
        dispatchId: dispatch.id,
        runId: dispatch.run_id,
        error
      })
    }
  }

  async listTerminals(
    worktreeSelector?: string,
    limit = DEFAULT_TERMINAL_LIST_LIMIT,
    opts: {
      handles?: readonly string[]
      requireFreshPtyLiveness?: boolean
      includeVisualLayouts?: boolean
    } = {}
  ): Promise<RuntimeTerminalListResult> {
    return this.terminalList.list(worktreeSelector, limit, opts)
  }

  async inspectTerminalProcessIncarnationLiveness(
    processIncarnation: string,
    serializedHostScope: string | null
  ): Promise<'live' | 'exited' | 'unverifiable'> {
    const hostScope = parseWorkerTerminalHostScope(serializedHostScope)
    if (!hostScope || !this.ptyController?.listProcesses) {
      return 'unverifiable'
    }
    const listed = await withTimeoutResult(
      this.ptyController.listProcesses(hostScope.kind === 'ssh' ? hostScope.targetId : null),
      PTY_CONTROLLER_LIST_TIMEOUT_MS
    )
    if (!listed.ok) {
      return 'unverifiable'
    }
    return classifyWorkerTerminalProcessIncarnation(processIncarnation, listed.value)
  }

  protected getTerminalTopologyRevision(worktreeId: string): number {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    return (
      this.getWorkspaceSessionForWorktree(worktreeId)?.terminalTopologyRevisionByRepoId?.[repoId] ??
      this.terminalTopologyRevisionByRepoId.get(repoId) ??
      0
    )
  }

  async adoptTerminalOrphans(
    request: RuntimeTerminalOrphanAdoptionRequest
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    if (request.claims.length === 0) {
      throw new Error('terminal_orphan_claims_required')
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
    return this.runWorktreeTerminalMutation(workspace.id, async () => {
      const resolvedWorkspace = workspace.folderWorkspace
        ? this.folderWorkspaceToResolvedWorktree(workspace.folderWorkspace)
        : await this.resolveWorktreeSelector(`id:${workspace.id}`)
      const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
        [resolvedWorkspace],
        workspace.id,
        undefined,
        workspace.connectionId ?? null
      )
      if (!inventory) {
        throw new Error('terminal_liveness_unavailable')
      }
      return this.adoptTerminalOrphansFromInventoryUnderMutation(request, workspace, inventory)
    })
  }
}
