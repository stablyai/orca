// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { sessionIdFromStructuredWorkerIncarnation } from './structured-worker-identity'
import { observeStructuredWorker } from './rpc/methods/orchestration-structured-worker-lifecycle'
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
import {
  CODEX_RECONNECT_SCAN_CONTEXT_CHARS,
  codexReconnectOutputScans,
  createCodexReconnectOutputScan,
  findCodexReconnectFailureBanner,
  stripTerminalControlSequences
} from './orca-runtime-on-pty-data'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration-task-display'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'

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
    cause: TerminalExitCause
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
    // A process that dies while we are stopping it is that stop succeeding, not a failure:
    // settling it as `failed` here made the in-flight worker-stop report its own success as an error.
    // Only a stop begun in THIS runtime can claim the exit; a `stopping` row left durable by a
    // killed process would otherwise absorb a much later crash as a clean stop.
    const stopping = this._orchestrationDb.getWorkerDispatch?.(dispatch.id)
    if (stopping?.state === 'stopping' && stopping.runtime_epoch === this.getRuntimeId()) {
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

    this.notifyWorkerDispatchFailure({
      dispatch,
      handle,
      failureLogLabel: 'worker exit',
      subject: `Agent exited unexpectedly (${errorContext})`,
      reason: errorContext,
      bodyPrefix: `Worker ${handle} stopped while running task`,
      payload: {
        taskId: dispatch.task_id,
        dispatchId: dispatch.id,
        exitCode,
        exitCause: cause,
        handle
      },
      settledStatus: settled?.status
    })
  }

  protected observeCodexReconnectFailureOutput(
    handle: string,
    paneKey: string | null,
    pty: object,
    output: string
  ): void {
    const db = this._orchestrationDb
    const scan = codexReconnectOutputScans.get(pty) ?? createCodexReconnectOutputScan()
    const dispatch = db?.getActiveDispatchForTerminal(handle, paneKey ?? undefined)
    const dispatchId = dispatch?.id ?? null
    if (dispatchId !== scan.dispatchId) {
      scan.dispatchId = dispatchId
      scan.tail = ''
      scan.pendingDispatchId = null
      scan.handledDispatchId = null
    }
    const combinedOutput = scan.tail + stripTerminalControlSequences(output)
    if (
      dispatch &&
      scan.pendingDispatchId !== dispatchId &&
      scan.handledDispatchId !== dispatchId
    ) {
      const match = findCodexReconnectFailureBanner(combinedOutput)
      if (match && match.end > scan.tail.length) {
        scan.pendingDispatchId = dispatchId
      }
    }
    if (dispatch && scan.pendingDispatchId === dispatchId) {
      const result = this.failCodexSessionUnrecoverableDispatch(dispatch, handle)
      if (result === 'settled' || result === 'ignored') {
        scan.handledDispatchId = dispatchId
        scan.pendingDispatchId = null
      }
    }
    scan.tail = dispatch ? combinedOutput.slice(-CODEX_RECONNECT_SCAN_CONTEXT_CHARS) : ''
    codexReconnectOutputScans.set(pty, scan)
  }

  protected failCodexSessionUnrecoverableDispatch(
    dispatch: { id: string; run_id: string; task_id: string },
    handle: string
  ): 'settled' | 'retry' | 'ignored' {
    const db = this._orchestrationDb
    if (!db) {
      return 'ignored'
    }
    const reason = 'Codex could not restore its app-server session'
    const settledStatus = db.failCodexSessionUnrecoverableDispatch(dispatch.id, reason)
    if (settledStatus === 'retry') {
      return 'retry'
    }
    if (settledStatus !== 'failed' && settledStatus !== 'circuit_broken') {
      return 'ignored'
    }
    this.notifyWorkerDispatchFailure({
      dispatch,
      handle,
      failureLogLabel: 'worker failure',
      taskDispositionNote:
        ' The task was marked failed pending coordinator review and will not be retried automatically.',
      subject: `Agent session failed (${reason})`,
      reason,
      bodyPrefix: `Worker ${handle} could not continue task`,
      bodySuffix: ' The terminal and worktree were kept for diagnosis.',
      payload: {
        taskId: dispatch.task_id,
        dispatchId: dispatch.id,
        handle,
        failureKind: 'codex_session_unrecoverable',
        terminalPreserved: true,
        worktreePreserved: true
      },
      settledStatus
    })
    return 'settled'
  }

  private notifyWorkerDispatchFailure(params: {
    dispatch: { id: string; run_id: string; task_id: string }
    handle: string
    failureLogLabel: 'worker exit' | 'worker failure'
    subject: string
    reason: string
    bodyPrefix: string
    bodySuffix?: string
    taskDispositionNote?: string
    payload: Record<string, unknown>
    settledStatus?: string
  }): void {
    const db = this._orchestrationDb
    if (!db) {
      return
    }
    try {
      // Why: a lightweight Run owns its own mailbox; legacy dispatches still fall back to the
      // active coordinator address read by `orchestration check`.
      const owningRun = db.getRun?.(params.dispatch.run_id)
      const active = db.getActiveCoordinatorRun?.()
      const recipient =
        owningRun && owningRun.legacy !== 1
          ? { to: `run:${owningRun.id}`, runId: owningRun.id }
          : active
            ? { to: active.coordinator_handle, runId: undefined }
            : null
      if (!recipient) {
        return
      }
      const task = db.getTask?.(params.dispatch.task_id, params.dispatch.run_id)
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
      const named = title ? `"${title}" (${params.dispatch.task_id})` : params.dispatch.task_id
      const settlementNote =
        params.taskDispositionNote ??
        (params.settledStatus === 'circuit_broken'
          ? ' This task has now failed too many times, so it will not be retried automatically.'
          : params.settledStatus === 'failed'
            ? ' The task is ready to be dispatched again.'
            : '')
      const escalation = db.insertMessage({
        from: params.handle,
        to: recipient.to,
        subject: params.subject,
        body: `${params.bodyPrefix} ${named}. ${params.reason}.${settlementNote}${params.bodySuffix ?? ''}`,
        type: 'escalation',
        priority: 'high',
        payload: JSON.stringify(params.payload),
        runId: params.dispatch.run_id
      })
      this.notifyMessageArrived(escalation.to_handle, escalation.type)
    } catch (error) {
      console.warn(`[orchestration] failed to escalate ${params.failureLogLabel}`, {
        dispatchId: params.dispatch.id,
        runId: params.dispatch.run_id,
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
    const structuredSessionId = sessionIdFromStructuredWorkerIncarnation(processIncarnation)
    if (structuredSessionId) {
      // A structured session has no PTY, so the process table can only ever fail to find it —
      // answering `exited` from that absence would release a running provider child. The durable
      // agent-session records, walked forward to any `/clear` successor, are asked directly rather
      // than the in-memory identity registry: settlement forgets the registry entry, so gating on
      // one made a stopped worker's resource answer `unverifiable` forever and stay in
      // `worker-list --terminalState retained` for the life of the DB.
      return observeStructuredWorker({ sessionId: structuredSessionId }).status
    }
    const hostScope = parseWorkerTerminalHostScope(serializedHostScope)
    if (!hostScope || !this.ptyController?.listProcesses) {
      return 'unverifiable'
    }
    const listed = await withTimeoutResult(
      this.ptyController.listProcesses(
        hostScope.kind === 'ssh'
          ? toSshExecutionHostId(hostScope.targetId)
          : LOCAL_EXECUTION_HOST_ID
      ),
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
