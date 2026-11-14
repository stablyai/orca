import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'

export class RecoveryWorkspaceRuntime extends OrcaRuntimeService {
  beforeRecoveryWorkspace?: () => Promise<void> | undefined
  protected override async resolveWorkspaceSelector(selector: string): Promise<ResolvedWorktree> {
    if (selector !== 'id:repo-1::/tmp/worktree-a') {
      throw new Error('selector_not_found')
    }
    const git = {
      path: '/tmp/worktree-a',
      head: 'test-head',
      branch: 'test',
      isBare: false,
      isMainWorktree: false
    }
    return {
      ...git,
      id: 'repo-1::/tmp/worktree-a',
      repoId: 'repo-1',
      displayName: 'test',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git
    }
  }
  protected override async resolveBrowserWorkspace(selector: string) {
    await this.beforeRecoveryWorkspace?.()
    return super.resolveBrowserWorkspace(selector)
  }
  override getRuntimeId(): string {
    return 'runtime-a'
  }
  override async resolveBrowserExecutionHostKeyForWorkspace() {
    return { status: 'resolved' as const, executionHostKey: 'execution-host-a' }
  }
}

export type RecoveryRuntimeObservation = RecoveryWorkspaceRuntime & {
  projectedFrames: number
  sessionTabsSequence(): number
  peekSnapshotForClient(worktree: string, clientId: string): RuntimeMobileSessionTabsResult
  snapshotForClient(worktree: string, clientId: string): Promise<RuntimeMobileSessionTabsResult>
}
