import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { WorktreeProviderWorkspace } from '../../../shared/worktree/provider/worktree-provider-types'

export const WORKTREE_PROVIDER_MANAGED_CODE = 'worktree_provider_managed'

export class WorktreeProviderManagedRemovalError extends Error {
  readonly code = WORKTREE_PROVIDER_MANAGED_CODE
  readonly data: { provider: string; leaseId?: string }

  constructor(worktreeId: string, provider: WorktreeProviderWorkspace) {
    super(
      `Workspace ${worktreeId} is leased from worktree provider "${provider.name}". Run \`orca worktree release ${worktreeId}\` instead. Orca never removes a provider-managed checkout.`
    )
    this.name = 'WorktreeProviderManagedRemovalError'
    this.data = {
      provider: provider.name,
      ...(provider.leaseId ? { leaseId: provider.leaseId } : {})
    }
  }
}

export function providerWorkspaceOf(
  meta: Pick<WorktreeMeta, 'worktreeProvider'> | null | undefined
): WorktreeProviderWorkspace | undefined {
  return meta?.worktreeProvider
}

/** The single refusal used by every checkout-removal entry point. */
export function assertWorktreeNotProviderManaged(
  worktreeId: string,
  meta: Pick<WorktreeMeta, 'worktreeProvider'> | null | undefined
): void {
  const provider = providerWorkspaceOf(meta)
  if (provider) {
    throw new WorktreeProviderManagedRemovalError(worktreeId, provider)
  }
}
