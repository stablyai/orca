import { useEffect } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileComposerCreateSelection } from './mobile-composer-source-types'
import { worktreeCreateBasePrefetch } from './mobile-workspace-create-operations'

function worktreeCreatePrefetchBase(
  selection: MobileComposerCreateSelection | null
): string | undefined | null {
  if (!selection || selection.kind === 'new-branch') {
    return undefined
  }
  // Existing-branch reuse cannot claim a prepared checkout.
  if (selection.kind === 'branch' && selection.reuse) {
    return null
  }
  return selection.baseBranch
}

// Warm the host checkout cache before create so fetch and checkout do not delay the user’s submission.
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
