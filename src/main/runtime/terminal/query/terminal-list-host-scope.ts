import {
  type ExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-terminal-contracts'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { RuntimeFederationOperations } from '../../orchestration/federation/runtime-federation-operations'

export abstract class TerminalListHostScope extends RuntimeFederationOperations {
  protected abstract tryGetWorkspaceSessionHostIdForWorktree(
    worktreeId: string
  ): ExecutionHostId | null

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
}
