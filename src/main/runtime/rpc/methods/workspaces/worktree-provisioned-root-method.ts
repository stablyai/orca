import { buildCliWorkspaceProvenance } from '../../../../../shared/cli-workspace-provenance'
import { getLocalWorktreeCatalogVersion } from '../../../../workspaces/catalog/local-worktree-scan-generation'
import { WorktreeAdoptProvisionedRoot } from '../../../../../shared/rpc-contract/worktree-provisioned-root-params'
import { defineMethod } from '../../core'

export const WORKTREE_PROVISIONED_ROOT_METHOD = defineMethod({
  name: 'worktree.adoptProvisionedRoot',
  permission: 'workspace',
  params: WorktreeAdoptProvisionedRoot,
  handler: async (params, { runtime }) => {
    const {
      repo,
      linkedIssue,
      linkedPR,
      linkedGitLabMR,
      linkedGitLabIssue,
      cliProvenanceRequest,
      ...request
    } = params
    // Why: null clears a link on update; a fresh adoption has nothing to clear.
    const result = await runtime.adoptManagedProvisionedRoot(repo, {
      ...request,
      cliProvenance: buildCliWorkspaceProvenance(cliProvenanceRequest, {
        startupAgent: request.createdWithAgent,
        createdAt: Date.now()
      }),
      linkedIssue: linkedIssue ?? undefined,
      linkedPR: linkedPR ?? undefined,
      linkedGitLabMR: linkedGitLabMR ?? undefined,
      linkedGitLabIssue: linkedGitLabIssue ?? undefined
    })
    return { ...result, catalogVersion: getLocalWorktreeCatalogVersion(result.worktree.repoId) }
  }
})
