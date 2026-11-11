import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { adoptCopyAtPath } from '../../perforce/perforce-copy-worktrees'
import type {
  WorkspaceSelectorCandidate,
  WorkspaceSelectorOptions
} from './catalog/workspace-selector-candidates'
import { RuntimeWorkspaceSelectors } from './workspace-selectors'

/** Lets a path: selector name a Perforce copy that Orca has not listed yet. */
export abstract class RuntimeWorkspaceSelectorsWithCopyAdoption extends RuntimeWorkspaceSelectors {
  protected override async resolveWorkspaceCandidate(
    selector: string,
    options: WorkspaceSelectorOptions = {}
  ): Promise<WorkspaceSelectorCandidate> {
    try {
      return await super.resolveWorkspaceCandidate(selector, options)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'selector_not_found' ||
        !selector.startsWith('path:')
      ) {
        throw error
      }
      const { requiredHostId } = options
      const repos = (this.store?.getRepos() ?? []).filter(
        (repo) => requiredHostId === undefined || getRepoExecutionHostId(repo) === requiredHostId
      )
      // Why: a copy made outside Orca joins only when its project's copies are synced, which the
      // sidebar does once per session, so a selector naming its folder syncs on the spot.
      const adopted = await adoptCopyAtPath(selector.slice(5), repos, (repo) =>
        this.runPerforceCopyOperationOnRepo(repo, 'syncCopies', {})
      )
      if (!adopted) {
        throw error
      }
      this.invalidateResolvedWorktreeCache()
      return super.resolveWorkspaceCandidate(selector, options)
    }
  }
}
