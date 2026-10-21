import { useEffect } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileComposerCreateSelection } from './mobile-composer-source-types'
import { worktreeCreateBasePrefetch } from './mobile-workspace-create-operations'

/** The base a create from this selection starts from; null when no prepared checkout can serve it. */
function worktreeCreatePrefetchBase(
  selection: MobileComposerCreateSelection | null
): string | undefined | null {
  if (!selection || selection.kind === 'new-branch') {
    return undefined
  }
  // Why: reusing an existing branch checks it out as-is, so a prepared checkout is never claimed.
  if (selection.kind === 'branch' && selection.reuse) {
    return null
  }
  return selection.baseBranch
}

// Why: without this the host fetches the base and checks out every file inside worktree.create;
// desktop's composer warms the same host-side cache on open, which is what makes its create fast.
export function useWorktreeCreateBasePrefetch(args: {
  client: RpcClient | null
  repoId: string | null
  repoIsGit: boolean
  selection: MobileComposerCreateSelection | null
}): void {
  const { client, repoId, repoIsGit } = args
  const baseBranch = worktreeCreatePrefetchBase(args.selection)
  useEffect(() => {
    if (!client || !repoId || !repoIsGit || baseBranch === null) {
      return
    }
    void worktreeCreateBasePrefetch
      .request(client, { repo: `id:${repoId}`, ...(baseBranch ? { baseBranch } : {}) })
      .catch(() => {})
  }, [baseBranch, client, repoId, repoIsGit])
}
