import { useEffect, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileGitBranchCompareResult } from '../source-control/mobile-branch-compare'
import type { MobileGitStatusResult } from '../source-control/mobile-git-status'
import { resolveMobileBranchCompareBaseRef } from '../source-control/mobile-branch-base-ref'
import { fetchGithubRepoSlug } from './github-pr-rpc'
import { branchContextCompareRead, branchContextStatusRead } from './mobile-diff-review-operations'

export type MobilePrBranchContext = {
  branch: string | null
  headSha: string | null
  status: MobileGitStatusResult | null
  isGithubRepo: boolean
  repoLoaded: boolean
  loaded: boolean
}

// Use the same status.head then branchCompare head fallback as review so both surfaces identify check runs consistently.
export function deriveMobilePrBranchContext(
  status: MobileGitStatusResult | null,
  branchCompare: MobileGitBranchCompareResult | null
): { branch: string | null; headSha: string | null; status: MobileGitStatusResult | null } {
  return {
    branch: status?.branch ?? null,
    headSha: status?.head ?? branchCompare?.summary.headOid ?? null,
    status
  }
}

// Probe repo eligibility independently so the PR entry can appear before branch context; repo-only mode skips identity RPCs.
export function useMobilePrBranchContext(input: {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  includeBranchIdentity?: boolean
}): MobilePrBranchContext {
  const { client, connState, worktreeId, includeBranchIdentity = true } = input
  const [context, setContext] = useState<MobilePrBranchContext>({
    branch: null,
    headSha: null,
    status: null,
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
        status: null,
        isGithubRepo: false,
        repoLoaded: false,
        loaded: !includeBranchIdentity
      })
      return
    }
    setContext({
      branch: null,
      headSha: null,
      status: null,
      isGithubRepo: false,
      repoLoaded: false,
      loaded: !includeBranchIdentity
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
      // Failed repo probes hide only the entry; branch data may still power panel state.
      .catch(() => {
        if (!cancelled) {
          setContext((prev) => ({
            ...prev,
            isGithubRepo: false,
            repoLoaded: true
          }))
        }
      })

    if (!includeBranchIdentity) {
      return () => {
        cancelled = true
      }
    }

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
      // Contain branch-read rejection while retaining repo eligibility and a readable unavailable state.
      .catch(() => {
        if (!cancelled) {
          setContext((prev) => ({
            ...prev,
            branch: null,
            headSha: null,
            status: null,
            loaded: true
          }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [ready, client, worktreeId, includeBranchIdentity])

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
): Promise<Pick<MobilePrBranchContext, 'branch' | 'headSha' | 'status'>> {
  const [status, branchCompare] = await Promise.all([
    readGitStatus(client, worktreeId),
    // Branch compare is only the SHA fallback here; failure must not hide a PR panel whose status read works.
    readBranchCompare(client, worktreeId).catch(() => null)
  ])
  return deriveMobilePrBranchContext(status, branchCompare)
}

async function readGitStatus(
  client: RpcClient,
  worktreeId: string
): Promise<MobileGitStatusResult | null> {
  const reply = await branchContextStatusRead.request(client, { worktree: `id:${worktreeId}` })
  const status = branchContextStatusRead.interpret(reply)
  return status.accepted ? status.value : null
}

async function readBranchCompare(
  client: RpcClient,
  worktreeId: string
): Promise<MobileGitBranchCompareResult | null> {
  // Without a base ref, rely on status.head instead of attempting branch compare.
  const baseRef = await resolveMobileBranchCompareBaseRef(client, worktreeId)
  if (!baseRef) {
    return null
  }
  const reply = await branchContextCompareRead.request(client, {
    worktree: `id:${worktreeId}`,
    baseRef
  })
  const compared = branchContextCompareRead.interpret(reply)
  return compared.accepted ? compared.value : null
}
