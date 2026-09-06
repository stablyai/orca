// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithHasExactPersistedTerminalSurfaceIdentity } from './orca-runtime-has-exact-persisted-terminal-surface-identity'
import type { OrchestrationWorkerServer } from './orchestration/environment-transport'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import type { RuntimeTerminalSummary } from '../../shared/runtime-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

export class OrcaRuntimeWithGetRuntimeId extends OrcaRuntimeWithHasExactPersistedTerminalSurfaceIdentity {
  getRuntimeId(): string {
    return this.runtimeId
  }

  resolveOrchestrationWorkerServer(selector: string): OrchestrationWorkerServer {
    return this.orchestrationFederation.resolveWorkerServer(selector)
  }

  callOrchestrationWorkerServer(
    selector: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
    envelope?: RuntimeOrchestrationEnvelope,
    internal?: { contractVerified?: boolean }
  ): Promise<unknown> {
    return this.orchestrationFederation.callWorkerServer(
      selector,
      method,
      params,
      timeoutMs,
      envelope,
      internal
    )
  }

  syncOrchestrationFederation(runId?: string): Promise<void> {
    return this.orchestrationFederation.sync(runId)
  }

  syncOrchestrationFederatedDispatch(dispatchId: string): Promise<void> {
    return this.orchestrationFederation.syncDispatch(dispatchId)
  }

  syncOrchestrationFederatedDispatchAfterCurrent(dispatchId: string): Promise<void> {
    return this.orchestrationFederation.syncDispatchAfterCurrent(dispatchId)
  }

  ensureOrchestrationFederationRelay(runId?: string): void {
    this.orchestrationFederation.ensureRelay(runId)
  }

  stopOrchestrationFederationRelay(): void {
    this.orchestrationFederation.stopRelay()
  }

  getStartedAt(): number {
    return this.startedAt
  }

  protected tryGetWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId | null {
    return this.workspaceSessions.tryGetHostId(worktreeId)
  }

  protected listKnownExecutionHostIds(
    additionalHostIds: Iterable<ExecutionHostId> = [],
    includeConfiguredHosts = true
  ): Set<ExecutionHostId> {
    const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
    for (const hostId of this.store?.getWorkspaceSessionHostIds?.() ?? []) {
      hostIds.add(hostId)
    }
    for (const hostId of additionalHostIds) {
      if (!/%|\s/.test(hostId)) {
        hostIds.add(hostId)
      }
    }
    if (includeConfiguredHosts) {
      for (const repo of this.store?.getRepos?.() ?? []) {
        hostIds.add(getRepoExecutionHostId(repo))
      }
      for (const folder of this.store?.getFolderWorkspaces?.() ?? []) {
        if (folder.executionHostId) {
          hostIds.add(folder.executionHostId)
        } else if (folder.connectionId) {
          hostIds.add(toSshExecutionHostId(folder.connectionId))
        }
      }
    }
    return hostIds
  }

  protected buildTerminalListHostScope(
    targetWorktreeId: string | null,
    terminals: readonly RuntimeTerminalSummary[],
    worktrees: Iterable<ResolvedWorktree>,
    queriedHostIds: ReadonlySet<ExecutionHostId>
  ): { hostIds: ExecutionHostId[]; omittedHostIds: ExecutionHostId[] } {
    const known = this.listKnownExecutionHostIds(
      queriedHostIds,
      targetWorktreeId !== FLOATING_TERMINAL_WORKTREE_ID
    )
    let targetHost: ExecutionHostId | null = null
    for (const worktree of worktrees) {
      if (worktree.id === targetWorktreeId && worktree.hostId) {
        targetHost = worktree.hostId
      }
    }
    for (const worktree of worktrees) {
      if (
        worktree.hostId &&
        (parseExecutionHostId(targetHost ?? '')?.kind !== 'runtime' ||
          worktree.id === targetWorktreeId)
      ) {
        known.add(worktree.hostId)
      }
    }
    for (const terminal of terminals) {
      if (terminal.executionHostId) {
        known.add(terminal.executionHostId)
      }
    }
    const scoped = targetWorktreeId
      ? (targetHost ?? this.tryGetWorkspaceSessionHostIdForWorktree(targetWorktreeId))
      : null
    if (scoped) {
      known.add(scoped)
      if (parseExecutionHostId(scoped)?.kind === 'runtime') {
        for (const folder of this.store?.getFolderWorkspaces?.() ?? []) {
          if (
            folder.executionHostId &&
            parseExecutionHostId(folder.executionHostId)?.kind === 'runtime' &&
            folder.connectionId
          ) {
            known.delete(toSshExecutionHostId(folder.connectionId))
          }
        }
      }
    }
    if (targetWorktreeId?.startsWith('folder:')) {
      const folderId = targetWorktreeId.slice('folder:'.length)
      const folder = this.store
        ?.getFolderWorkspaces?.()
        .find((candidate) => candidate.id === folderId)
      if (
        folder?.executionHostId &&
        parseExecutionHostId(folder.executionHostId)?.kind === 'runtime' &&
        folder.connectionId
      ) {
        known.delete(toSshExecutionHostId(folder.connectionId))
      }
    }
    const candidates = targetWorktreeId ? (scoped ? [scoped] : []) : [...known]
    const covered = new Set(
      candidates.filter(
        (id) => queriedHostIds.has(id) && parseExecutionHostId(id)?.kind !== 'runtime'
      )
    )
    return {
      hostIds: [...covered].sort(),
      omittedHostIds: [...known].filter((id) => !covered.has(id)).sort()
    }
  }

  protected getWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId {
    return this.workspaceSessions.getHostId(worktreeId)
  }

  protected getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null {
    return this.workspaceSessions.get(worktreeId)
  }

  protected setWorkspaceSessionForWorktree(
    worktreeId: string,
    session: WorkspaceSessionState
  ): void {
    this.workspaceSessions.set(worktreeId, session)
  }

  protected getKnownWorkspaceSessionWorktreeIds(): Set<string> {
    return this.workspaceSessions.getKnownWorktreeIds()
  }

  protected getWorkspaceSessionHydrationTargets(
    includeAllPersistedWorktrees: boolean
  ): Map<string, WorkspaceSessionState> {
    return this.workspaceSessions.getHydrationTargets(includeAllPersistedWorktrees)
  }
}
