import { sessionIdFromStructuredWorkerIncarnation } from '../../structured-worker-identity'
import { observeStructuredWorker } from '../../rpc/methods/orchestration-structured-worker-lifecycle'
import { OrcaRuntimeWithApplyMobileDisplayMode } from './terminal-display-mode'
import { addListenerToMap } from '../../orca-runtime-core'
import { notifyRuntimeListeners, withTimeoutResult } from '../../runtime-async-boundaries'
import type { TerminalExitCause } from '../../../../shared/terminal-exit-cause'
import {
  describeTerminalExitCause,
  isDeliberateTerminalExit
} from '../../../../shared/terminal-exit-cause'
import {
  DEFAULT_TERMINAL_LIST_LIMIT,
  PTY_CONTROLLER_LIST_TIMEOUT_MS
} from '../../orca-runtime-postlude'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult
} from '../../../../shared/runtime-terminal-contracts'
import { classifyWorkerTerminalProcessIncarnation } from '../../orchestration/worker-terminal-process-liveness'
import { parseWorkerTerminalHostScope } from '../../../../shared/worker-terminal-host-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { escalateWorkerFailure } from '../../orchestration/worker-failure-escalation'
import { dispatchReportMailbox } from '../../orchestration/dispatch-report-mailbox'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../../shared/execution-host'

export abstract class OrcaRuntimeWithSubscribeToTerminalResize extends OrcaRuntimeWithApplyMobileDisplayMode {
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

  // Section 7.2: observe exits directly so dispatch recovery need not wait for coordinator polling.
  protected failActiveDispatchOnExit(
    handle: string,
    paneKey: string | null,
    exitCode: number,
    cause: TerminalExitCause
  ): void {
    const db = this._orchestrationDb
    if (!db) {
      return
    }

    // Pane identity survives handle reminting.
    const dispatch = db.getActiveDispatchForTerminal(handle, paneKey ?? undefined)
    if (!dispatch) {
      return
    }
    // Only this runtime's in-flight stop claims a clean exit; durable stopping rows from a crashed runtime cannot absorb later crashes.
    const stopping = db.getWorkerDispatch?.(dispatch.id)
    if (stopping?.state === 'stopping' && stopping.runtime_epoch === this.getRuntimeId()) {
      db.settleWorkerStop(dispatch.id)
      return
    }

    const errorContext = describeTerminalExitCause(cause)
    const settled = db.failDispatch(dispatch.id, errorContext, {
      workerProcessExited: true,
      terminationReason: cause.kind
    })
    if (isDeliberateTerminalExit(cause)) {
      return
    }

    // Escalate unexpected exits on the next coordinator check even before its circuit breaker trips.
    escalateWorkerFailure(
      db,
      dispatch,
      {
        from: handle,
        mailbox: () => dispatchReportMailbox(db, dispatch),
        describe: (task) => ({
          subject: `Agent exited unexpectedly (${errorContext})`,
          body: `Worker ${handle} stopped while running task ${task}. ${errorContext}.${settled?.status === 'circuit_broken' ? ' This task has now failed too many times, so it will not be retried automatically.' : settled?.status === 'failed' ? ' The task is ready to be dispatched again.' : ''}`
        }),
        payload: {
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          exitCode,
          exitCause: cause,
          handle
        }
      },
      (to, type) => this.notifyMessageArrived(to, type)
    )
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
      // Structured sessions have no PTY; consult durable records through /clear successors. The in-memory registry vanishes at settlement, so absence there proves no exit.
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
