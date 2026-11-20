import {
  getRepoDialableSshTargetId,
  isRepoOnCatalogHost
} from '../../shared/execution-host/execution-host'
import { scopeHooksToRepoKind } from '../../shared/folder-workspaces/folder-workspace-hooks'
import { resolveHookCommandSourcePolicy } from '../../shared/workspace-setup/hooks/hook-command-source-policy'
import type { WorkspaceHookOwner } from '../../shared/workspace-setup/hooks/workspace-hook-owner'
import type { OrcaHooks } from '../../shared/workspace-setup/orca-yaml-hook-types'
import { ARCHIVE_HOOK_CHANGED_CODE } from '../../shared/worktree/removal/archive-hook-decision'
import { hashOrcaHookTrustContent } from './created-worktree-setup-trust'
import { hasHooksFile, loadHooks } from './hooks'

/** As the desktop's archive prompt: only a shared orca.yaml script needs trust; null means none does. */
export function archiveTrust(
  repo: WorkspaceHookOwner,
  sharedHooks: OrcaHooks | null
): { contentHash: string; scriptContent: string } | null {
  const localArchive = repo.hookSettings?.scripts.archive?.trim()
  const policy = resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(localArchive)
  })
  const sharedArchive = sharedHooks?.scripts.archive?.trim()
  return policy === 'local-only' || !sharedArchive
    ? null
    : { contentHash: hashOrcaHookTrustContent(sharedArchive), scriptContent: sharedArchive }
}

export class ArchiveHookChangedError extends Error {
  readonly code = ARCHIVE_HOOK_CHANGED_CODE
  constructor(path: string) {
    super(
      `The orca.yaml archive hook in ${path} changed after it was approved. Nothing was deleted. Approve it in Orca, or pass --archive run or --archive skip.`
    )
  }
}

/** A version-only approval names the content it approved; refuse when what would run now differs. */
export function assertArchiveHookStillApproved(
  owner: WorkspaceHookOwner,
  approvedArchiveHash: string
): void {
  // Only the host holding the files can read them; elsewhere the runner on that host decides.
  if (getRepoDialableSshTargetId(owner) || !isRepoOnCatalogHost(owner)) {
    return
  }
  const shared = scopeHooksToRepoKind(
    owner,
    hasHooksFile(owner.path) ? loadHooks(owner.path) : null
  )
  const current = shared?.scripts.archive?.trim() ?? ''
  if (hashOrcaHookTrustContent(current) !== approvedArchiveHash) {
    throw new ArchiveHookChangedError(owner.path)
  }
}
