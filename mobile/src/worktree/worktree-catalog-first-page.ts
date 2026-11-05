import type { RpcClient } from '../transport/rpc-client'
import type { Worktree } from './workspace-list-types'
import { worktreeCatalogRead } from './worktree-catalog-operations'
import { admitWorktreeCatalogResponse } from './worktree-catalog-snapshot-client'

// About two screens of rows: small enough to arrive well ahead of a large catalog on a slow link.
export const WORKTREE_FIRST_PAGE_LIMIT = 60

/**
 * The host's first rows by its own ranking (pinned, unread, active, then most recent output), to
 * draw while the full catalog is still arriving. Null when the host refuses or answers otherwise.
 */
export async function readWorktreeFirstPage(client: RpcClient): Promise<Worktree[] | null> {
  const catalog = worktreeCatalogRead.interpret(
    await worktreeCatalogRead.request(client, { limit: WORKTREE_FIRST_PAGE_LIMIT })
  )
  if (!catalog.accepted) {
    return null
  }
  const admission = admitWorktreeCatalogResponse(catalog.value, null)
  return admission.kind === 'full' ? admission.worktrees : null
}
