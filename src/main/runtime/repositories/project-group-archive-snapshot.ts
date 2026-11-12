import type { ProjectGroupArchiveDecisions } from '../../../shared/project-group-removal'
import type { WorkspaceHookOwner } from '../../../shared/workspace-hook-owner'
import type { OrcaHooks } from '../../../shared/orca-yaml-hook-types'
import { isRepoOnCatalogHost } from '../../../shared/execution-host'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import { blockedWslDistroForPath } from '../../wsl/filesystem/wsl-unc-access-gate'
import { getEffectiveHooksFromConfig } from '../../workspace-hooks/effective-hook-config'
import { loadHooks, hasHooksFile } from '../../workspace-hooks/hooks'
import { hashOrcaHookTrustContent } from '../../workspace-hooks/created-worktree-setup-trust'

/** One owner snapshot binds every descendant execution to the same approved shared bytes. */
export async function resolveProjectGroupArchiveSnapshot(
  owner: WorkspaceHookOwner,
  groupId: string,
  decisions?: ProjectGroupArchiveDecisions
): Promise<OrcaHooks | null> {
  const decision = decisions && Object.hasOwn(decisions, groupId) ? decisions[groupId] : undefined
  if (decision?.decision === 'skip' || !isRepoOnCatalogHost(owner)) {
    return null
  }
  if (await blockedWslDistroForPath(owner.path)) {
    return null
  }
  const policy = resolveHookCommandSourcePolicy(owner.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(owner.hookSettings?.scripts.archive?.trim())
  })
  let shared: OrcaHooks | null = null
  if (policy !== 'local-only') {
    shared = loadHooks(owner.path)
    if (!shared && hasHooksFile(owner.path)) {
      console.warn(`[hooks] skipped unreadable group archive for ${owner.displayName}`)
      return null
    }
    const content = shared?.scripts.archive?.trim()
    if (
      content &&
      (decision?.decision !== 'run' ||
        decision.approvedContentHash !== hashOrcaHookTrustContent(content))
    ) {
      console.warn(`[hooks] skipped unapproved group archive for ${owner.displayName}`)
      return null
    }
  }
  return getEffectiveHooksFromConfig(owner, shared)
}
