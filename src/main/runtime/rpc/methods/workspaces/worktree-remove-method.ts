import { WorktreeRemove } from '../../../../../shared/rpc-contract/workspaces/worktree-params'
import { splitWorktreeId } from '../../../../../shared/worktree/id'
import {
  requestedArchiveHookDecision,
  withArchiveHookReport,
  type ArchiveHookChoice,
  type ArchiveHookDecision
} from '../../../../../shared/worktree/removal/archive-hook-decision'
import { normalizeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { getLocalWorktreeCatalogVersion } from '../../../../workspaces/catalog/local-worktree-scan-generation'
import { resolveWorktreeRemovalRepoOwner } from '../../../../workspaces/removal/worktree-removal-repo-owner'
import { decideArchiveHook } from '../../../../workspace-hooks/inherited-archive-hook-decision'
import { getExplicitWorktreeIdSelector } from '../../../workspaces/catalog/runtime-worktree-selection'
import { queueWorkspaceDelete } from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { PersistedTrustedOrcaHooks } from '../../../../../shared/workspace-setup/orca-yaml-hook-types'
import { defineMethod } from '../../core'
import { waitsForWorktreeRemoval } from '../../workspace-client-views/worktree-removal-marker-projection'
import { resolvePairedCallerHostId } from '../pairing/paired-caller-host-id'

export const WORKTREE_REMOVE_METHOD = defineMethod({
  name: 'worktree.rm',
  permission: 'workspace',
  params: WorktreeRemove,
  handler: async (params, context) => {
    const { runtime } = context
    if (runtime.ownsRecipeWorkspaceRemoval?.(params)) {
      return runtime.removeRecipeWorkspace(params)
    }
    // Translate a paired client's runtime-local host spelling before host-qualified reads.
    let resolvedHostId = resolvePairedCallerHostId(
      () => runtime.listRepos(),
      params.worktree,
      params.hostId
    )
    // Older mobile omits hostId; resolve ambiguity before pinning removal and refuse ids shared by two hosts.
    if (!resolvedHostId) {
      try {
        resolvedHostId = (await runtime.showManagedWorktree(params.worktree)).hostId
        if (!resolvedHostId) {
          throw new Error('worktree.rm could not resolve the workspace host')
        }
      } catch (error) {
        // Git may omit a stale path: selector_not_found must reach removeManagedWorktree; propagate other resolution failures.
        if (!(error instanceof Error) || error.message !== 'selector_not_found') {
          throw error
        }
      }
    }
    // Parse id: selectors for repo stamping; resolving again scans and rejects ids shared by hosts. Leave other selectors unstamped.
    const explicitWorktreeId = getExplicitWorktreeIdSelector(params.worktree)
    const repoId = explicitWorktreeId ? splitWorktreeId(explicitWorktreeId)?.repoId : undefined
    let archiveDecision: ArchiveHookDecision | undefined
    const result = await queueWorkspaceDelete(
      runtime,
      params.worktree,
      resolvedHostId,
      params,
      async (removal) => {
        // Decided once the queue admits the delete, against the approvals current at that moment.
        archiveDecision = params.archiveHooks
          ? await decideWorktreeArchiveHook(runtime, params.worktree, params.archiveHooks)
          : undefined
        const options = {
          ...removal,
          ...(archiveDecision ? { runHooks: archiveDecision.decision === 'run' } : {}),
          waitForBackgroundRemoval: waitsForWorktreeRemoval(context, params)
        }
        return params.approvedNestedWorktrees
          ? runtime.removeManagedWorktreeWithNested(
              params.worktree,
              params.approvedNestedWorktrees,
              options
            )
          : runtime.removeManagedWorktree(params.worktree, options)
      }
    )
    return {
      removed: result.removing !== true,
      ...withArchiveHookReport(result, archiveDecision),
      ...(repoId ? { catalogVersion: getLocalWorktreeCatalogVersion(repoId) } : {})
    }
  }
})

async function decideWorktreeArchiveHook(
  runtime: OrcaRuntimeService,
  selector: string,
  choice: ArchiveHookChoice
): Promise<ArchiveHookDecision> {
  if (choice !== 'inherit') {
    return requestedArchiveHookDecision(choice)
  }
  let owner
  try {
    const worktree = await runtime.showManagedWorktree(selector)
    const repos = runtime.listRepos()
    const resolved = resolveWorktreeRemovalRepoOwner(
      { getRepos: () => repos, getRepo: (id) => repos.find((repo) => repo.id === id) },
      worktree.repoId,
      normalizeExecutionHostId(worktree.hostId) ?? undefined
    )
    owner = resolved.kind === 'resolved' ? resolved.repo : undefined
  } catch {
    owner = undefined
  }
  return decideArchiveHook(choice, owner, () => ({
    trust: readHookTrust(runtime),
    repos: runtime.listRepos()
  }))
}

// A runtime without a UI store has no approvals, so only scripts that need none run.
function readHookTrust(runtime: OrcaRuntimeService): PersistedTrustedOrcaHooks | undefined {
  try {
    return runtime.getUIState().trustedOrcaHooks
  } catch {
    return undefined
  }
}
