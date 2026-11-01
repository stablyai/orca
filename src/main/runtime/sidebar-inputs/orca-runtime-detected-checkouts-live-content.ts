import { OrcaRuntimeWithWorkspaceReviewFacts } from './orca-runtime-workspace-review-facts'
import { isFolderRepo } from '../../../shared/repo-kind'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import type { WorkspaceLiveContent } from '../../../shared/sidebar-list/workspace-live-content'
import { runtimeVisibleRepos } from '../runtime-visible-catalog'
import { DetectedCheckoutsProducer } from './detected-checkouts-producer'
import { WorkspaceLiveContentProducer } from './workspace-live-content-producer'

/** Two producers published for readers still to come: detected checkouts and live terminal content. */
export abstract class OrcaRuntimeWithDetectedCheckoutsAndLiveContent extends OrcaRuntimeWithWorkspaceReviewFacts {
  readonly detectedCheckouts = new DetectedCheckoutsProducer({
    repos: () => runtimeVisibleRepos(this.store).filter((repo) => !isFolderRepo(repo)),
    listDetected: (repo) => this.listDetectedWorktreesForResolvedRepo(repo),
    onClientEvent: (listener, options) => this.onClientEvent(listener, options)
  })
  readonly workspaceLiveContent = new WorkspaceLiveContentProducer((worktreeId) =>
    this.readWorkspaceLiveContent(worktreeId)
  )

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithWorkspaceReviewFacts>) {
    super(...args)
    this.workspaceActivityFacts.onWorkspaceRefreshed((worktreeId) =>
      this.workspaceLiveContent.refresh(worktreeId)
    )
  }

  private readWorkspaceLiveContent(worktreeId: string): WorkspaceLiveContent {
    const hasAttachedPty = [...this.leaves.values()].some(
      (leaf) =>
        leaf.connected && leaf.ptyId !== null && worktreeIdsEqual(leaf.worktreeId, worktreeId)
    )
    return { liveTerminalCount: this.getLivePtyIdsForWorktree(worktreeId).size, hasAttachedPty }
  }
}
