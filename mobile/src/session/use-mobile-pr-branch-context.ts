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
  repoLoaded: boolean
  loaded: boolean
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

// Loads repo eligibility independently from branch/SHA. The header PR icon only
// needs the cheap GitHub probe; the panel can keep loading branch context after
// the entry point is already stable in the top bar.
export function useMobilePrBranchContext(input: {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
}): MobilePrBranchContext {
  const { client, connState, worktreeId } = input
  const [context, setContext] = useState<MobilePrBranchContext>({
    branch: null,
    headSha: null,
    isGithubRepo: false,
    repoLoaded: false,
    loaded: false
  })

  const ready = client !== null && connState === 'connected'

  useEffect(() => {
    let cancelled = false
    if (!ready || !client) {
      setContext({
        branch: null,
        headSha: null,
        isGithubRepo: false,
        repoLoaded: false,
        loaded: false
      })
      return
    }
    setContext({
      branch: null,
      headSha: null,
      isGithubRepo: false,
      repoLoaded: false,
      loaded: false
    })

    void loadMobilePrRepoContext(client, worktreeId)
      .then((next) => {
        if (!cancelled) {
          setContext((prev) => ({
            ...prev,
            isGithubRepo: next.isGithubRepo,
            repoLoaded: true
          }))
        }
      })
      // Why: a rejected repo probe should only hide the PR entry, not block
      // branch context that can still power the panel's loading/error state.
      .catch(() => {
        if (!cancelled) {
          setContext((prev) => ({
            ...prev,
            isGithubRepo: false,
            repoLoaded: true
          }))
        }
      })

    void loadMobilePrBranchIdentity(client, worktreeId)
      .then((next) => {
        if (!cancelled) {
          setContext((prev) => ({
            ...prev,
            ...next,
            loaded: true
          }))
        }
      })
      // Why: a rejected branch read must not escape as an unhandled rejection;
      // keep repo eligibility and let the panel show "branch unavailable".
      .catch(() => {
        if (!cancelled) {
          setContext((prev) => ({
            ...prev,
            branch: null,
            headSha: null,
            loaded: true
          }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [ready, client, worktreeId])

  return context
}

export async function loadMobilePrBranchContext(
  client: RpcClient,
  worktreeId: string
): Promise<MobilePrBranchContext> {
  const [branch, repo] = await Promise.all([
    loadMobilePrBranchIdentity(client, worktreeId),
    loadMobilePrRepoContext(client, worktreeId)
  ])
  return { ...branch, ...repo, repoLoaded: true, loaded: true }
}

export async function loadMobilePrRepoContext(
  client: RpcClient,
  worktreeId: string
): Promise<Pick<MobilePrBranchContext, 'isGithubRepo'>> {
  const slugOutcome = await fetchGithubRepoSlug(client, worktreeId)
  return { isGithubRepo: slugOutcome.ok && slugOutcome.result !== null }
}

export async function loadMobilePrBranchIdentity(
  client: RpcClient,
  worktreeId: string
): Promise<Pick<MobilePrBranchContext, 'branch' | 'headSha'>> {
  const [status, branchCompare] = await Promise.all([
    readGitStatus(client, worktreeId),
    // Why: the standalone PR entry point only needs branchCompare as a head-SHA
    // fallback; compare failures must not hide the PR panel when git.status works.
    readBranchCompare(client, worktreeId).catch(() => null)
  ])
  return deriveMobilePrBranchContext(status, branchCompare)
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
