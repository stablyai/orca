import { OrcaRuntimeWithListManagedWorktrees } from './managed-workspace-operations'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { phoneWakeReport, type SleepingAgentWakeReport } from '../../../shared/workspace-sleep'

export abstract class OrcaRuntimeWithWakeManagedWorktree extends OrcaRuntimeWithListManagedWorktrees {
  /** `worktree.wake`: resumes a workspace's slept agents without navigating any window. */
  async wakeManagedWorktree(
    worktreeSelector: string
  ): Promise<{ worktreeId: string; sleepingAgentWake: SleepingAgentWakeReport }> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('repo_not_found')
    }
    return { worktreeId: worktree.id, sleepingAgentWake: this.wakeSleepingAgents(repo, worktree.id) }
  }

  // Why: main resumes a workspace sleep's agents; only a window wakes its own hibernation.
  protected wakeSleepingAgents(repo: Repo, worktreeId: string): SleepingAgentWakeReport {
    // Not awaited: behind a running sleep it would outlast the caller's request timeout.
    void this.queueSleepingAgentWake(worktreeId)
    // Why the repo's host: records are partitioned by it, so SSH workspaces are not missed.
    const records = this.store?.getWorkspaceSession?.(getRepoExecutionHostId(repo))
    return phoneWakeReport(
      records?.sleepingAgentSessionsByPaneKey,
      worktreeId,
      Boolean(this.getAvailableAuthoritativeWindow())
    )
  }
}
