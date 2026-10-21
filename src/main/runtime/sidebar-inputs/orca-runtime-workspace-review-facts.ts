import { OrcaRuntimeWithWorkspaceActivityFacts } from './orca-runtime-workspace-activity-facts'
import {
  buildWorkspaceReviewFacts,
  type WorkspaceReviewFactsSnapshot
} from '../../../shared/sidebar-list/workspace-review-facts'

/**
 * PR facts per workspace, read on demand from this host's copy of the PR cache. The window
 * persists its cache here within a second of any change; orcad has no window, so it reads only
 * what its profile already holds.
 */
export abstract class OrcaRuntimeWithWorkspaceReviewFacts extends OrcaRuntimeWithWorkspaceActivityFacts {
  async getWorkspaceReviewFacts(): Promise<WorkspaceReviewFactsSnapshot> {
    if (!this.store) {
      return { facts: {} }
    }
    const { worktrees } = await this.listResolvedWorktreeSnapshot()
    return {
      facts: buildWorkspaceReviewFacts(
        worktrees,
        this.store.getRepos(),
        this.store.getGitHubCache().pr
      )
    }
  }
}
