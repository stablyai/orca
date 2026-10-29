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
import type { OrchestrationDb } from '../../orchestration/db'

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
    const errorContext = describeTerminalExitCause(cause)
    this.failActiveDispatchAndEscalate(handle, paneKey ?? undefined, {
      error: errorContext,
      options: { workerProcessExited: true, terminationReason: cause.kind },
      processExited: true,
      // Escalate unexpected exits on the next coordinator check even before its circuit breaker trips.
      escalate: !isDeliberateTerminalExit(cause),
      describe: (task, outcome) => ({
        subject: `Agent exited unexpectedly (${errorContext})`,
        body: `Worker ${handle} stopped while running task ${task}. ${errorContext}.${outcome}`
      }),
      payload: { exitCode, exitCause: cause }
    })
  }

  /** Codex outlives a failed reconnect, so no PTY exit will ever settle its dispatch (#24791). */
  protected settleLostAgentSession(ptyId: string): void {
    const surfaces: { handle: string | undefined; paneKey?: string }[] = [
      ...this.getLeavesForPty(ptyId).map((leaf) => ({
        handle: this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId)),
        paneKey: this.makeRuntimePaneKey(leaf)
      })),
      // Pane identity survives handle reminting, as on the exit path.
      {
        handle: this.handleByPtyId.get(ptyId),
        paneKey: this.paneOfPty(this.ptysById.get(ptyId)).paneKey ?? undefined
      }
    ]
    const reason = 'Codex lost its app-server and could not reconnect; relaunch Codex to continue'
    try {
      surfaces.some(
        ({ handle, paneKey }) =>
          handle !== undefined &&
          this.failActiveDispatchAndEscalate(handle, paneKey, {
            error: reason,
            // The terminal and worktree stay up for inspection; workerProcessExited bypasses the active-worker guard for this dead session.
            options: { workerProcessExited: true, workerStage: 'agent_session_lost' },
            processExited: false,
            escalate: true,
            describe: (task, outcome) => ({
              subject: 'Agent session lost',
              body: `Worker ${handle} can no longer run task ${task}: ${reason}. Its terminal is still open for inspection.${outcome}`
            }),
            payload: { reason }
          })
      )
    } catch (error) {
      console.warn('[orchestration] failed to settle a lost agent session', ptyId, error)
    }
  }

  /** Returns whether the surface had an active dispatch. */
  private failActiveDispatchAndEscalate(
    handle: string,
    paneKey: string | undefined,
    failure: {
      error: string
      options: Parameters<OrchestrationDb['failDispatch']>[2]
      processExited: boolean
      escalate: boolean
      describe: (task: string, outcome: string) => { subject: string; body: string }
      payload: Record<string, unknown>
    }
  ): boolean {
    const db = this._orchestrationDb
    // Pane identity survives handle reminting.
    const dispatch = db?.getActiveDispatchForTerminal(handle, paneKey)
    if (!db || !dispatch) {
      return false
    }
    // Only this runtime's in-flight stop claims the outcome; durable stopping rows from a crashed runtime cannot absorb later failures.
    const stopping = db.getWorkerDispatch?.(dispatch.id)
    if (stopping?.state === 'stopping' && stopping.runtime_epoch === this.getRuntimeId()) {
      if (failure.processExited) {
        db.settleWorkerStop(dispatch.id)
      }
      return true
    }
    const settled = db.failDispatch(dispatch.id, failure.error, failure.options)
    if (!failure.escalate) {
      return true
    }
    escalateWorkerFailure(
      db,
      dispatch,
      {
        from: handle,
        mailbox: () => dispatchReportMailbox(db, dispatch),
        describe: (task) =>
          failure.describe(
            task,
            settled?.status === 'circuit_broken'
              ? ' This task has now failed too many times, so it will not be retried automatically.'
              : settled?.status === 'failed'
                ? ' The task is ready to be dispatched again.'
                : ''
          ),
        payload: {
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          ...failure.payload,
          handle
        }
      },
      (to, type) => this.notifyMessageArrived(to, type)
    )
    return true
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
        : await this.resolveGitWorktreeSelector(`id:${workspace.id}`)
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
