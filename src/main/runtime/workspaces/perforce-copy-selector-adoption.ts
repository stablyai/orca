import { existsSync } from 'node:fs'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceCopyListResult } from '../../../shared/perforce/workspace-copy/workspace-copy-types'
import { adoptCopyAtPath, resolveWithCopyAdoption } from '../../perforce/perforce-copy-worktrees'
import type { ResolvedWorktree } from './catalog/runtime-worktree-path-identity'
import { RuntimeWorkspaceSelectors } from './workspace-selectors'

/**
 * Lets a path: selector name a Perforce copy that Orca has not listed yet: the sidebar syncs a
 * project's copies once per session, so a copy made after that is adopted when first named.
 */
export abstract class RuntimeWorkspaceSelectorsWithCopyAdoption extends RuntimeWorkspaceSelectors {
  // Why this resolver: agent launches and workspace lookups both reach it, so every caller adopts.
  protected override resolveGitWorktreeSelector(
    selector: string,
    requiredHostId?: ExecutionHostId
  ): Promise<ResolvedWorktree> {
    return resolveWithCopyAdoption(
      selector,
      () => super.resolveGitWorktreeSelector(selector, requiredHostId),
      async (path) => {
        const adopted = await adoptCopyAtPath(path, this.store?.getRepos() ?? [], {
          requiredHostId,
          folderExists: existsSync,
          syncCopies: async (repo) =>
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: syncCopies answers with the copy listing it adopted from.
            (await this.runPerforceCopyOperationOnRepo(
              repo,
              'syncCopies',
              {}
            )) as WorkspaceCopyListResult
        })
        if (adopted) {
          this.invalidateResolvedWorktreeCache()
        }
        return adopted
      }
    )
  }
}
