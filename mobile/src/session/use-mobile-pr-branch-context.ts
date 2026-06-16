import { useEffect, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileGitBranchCompareResult } from '../source-control/mobile-branch-compare'
import type { MobileGitStatusResult } from '../source-control/mobile-git-status'
import { resolveMobileBranchCompareBaseRef } from '../source-control/mobile-branch-base-ref'
import { fetchGithubRepoSlug } from './github-pr-rpc'
import { readMobileBranchCompareResult, readMobileGitStatusResult } from './mobile-diff-review-rpc'

export type MobilePrBranchContext = {
  branch: string | null
  headSha: string | null
  isGithubRepo: boolean
}

// Pure derivation of branch + head SHA from a git.status + git.branchCompare snapshot.
// Head SHA must match the review path's precedence (use-mobile-diff-review-controller.ts):
// `status.head ?? branchCompare.summary.headOid ?? null` — a status-only read would lose
// the SHA when `status.head` is absent and diverge from the review surface's check status.
export function deriveMobilePrBranchContext(
  status: MobileGitStatusResult | null,
  branchCompare: MobileGitBranchCompareResult | null
): { branch: string | null; headSha: string | null } {
  return {
    branch: status?.branch ?? null,
    headSha: status?.head ?? branchCompare?.summary.headOid ?? null
  }
}

// Loads git.status + git.branchCompare for the worktree (the standalone PR panel can't
// ride on the review screen's state) and exposes isGithubRepo so the session header can
// gate the PR icon without mounting the panel (KTD4). RPC plumbing only — the branch/SHA
// derivation lives in the pure deriveMobilePrBranchContext for testing.
export function useMobilePrBranchContext(input: {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
}): MobilePrBranchContext {
  const { client, connState, worktreeId } = input
  const [context, setContext] = useState<MobilePrBranchContext>({
    branch: null,
    headSha: null,
    isGithubRepo: false
  })

  const ready = client !== null && connState === 'connected'

  useEffect(() => {
    let cancelled = false
    if (!ready || !client) {
      setContext({ branch: null, headSha: null, isGithubRepo: false })
      return
    }
    void loadMobilePrBranchContext(client, worktreeId).then((next) => {
      if (!cancelled) {
        setContext(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [ready, client, worktreeId])

  return context
}

async function loadMobilePrBranchContext(
  client: RpcClient,
  worktreeId: string
): Promise<MobilePrBranchContext> {
  const [status, branchCompare, slugOutcome] = await Promise.all([
    readGitStatus(client, worktreeId),
    readBranchCompare(client, worktreeId),
    fetchGithubRepoSlug(client, worktreeId)
  ])
  return {
    ...deriveMobilePrBranchContext(status, branchCompare),
    isGithubRepo: slugOutcome.ok && slugOutcome.result !== null
  }
}

async function readGitStatus(
  client: RpcClient,
  worktreeId: string
): Promise<MobileGitStatusResult | null> {
  const response = await client.sendRequest('git.status', { worktree: `id:${worktreeId}` })
  return response.ok ? readMobileGitStatusResult(response.result) : null
}

async function readBranchCompare(
  client: RpcClient,
  worktreeId: string
): Promise<MobileGitBranchCompareResult | null> {
  // branchCompare requires a baseRef; without one (or on error) the headOid fallback is
  // simply unavailable and headSha relies on status.head.
  const baseRef = await resolveMobileBranchCompareBaseRef(client, worktreeId)
  if (!baseRef) {
    return null
  }
  const response = await client.sendRequest('git.branchCompare', {
    worktree: `id:${worktreeId}`,
    baseRef
  })
  return response.ok ? readMobileBranchCompareResult(response.result) : null
}
