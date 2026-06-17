import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import {
  fetchGithubRepoSlug,
  fetchHostedReviewForBranch,
  fetchPRChecks,
  fetchPRForBranch,
  fetchWorkItemDetails
} from './github-pr-rpc'
import {
  loadPrSidebarData,
  loadPrSidebarDetails,
  shouldApplyResult,
  type PrSidebarLoadDeps,
  type PrSidebarState
} from './mobile-pr-sidebar-state'
import { fetchWorktreeLinkedPR } from '../source-control/mobile-pr-link'

type PrSidebarControllerInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  // Head branch + SHA come from git.status (`branch`/`head`) via the review screen,
  // not the branchCompare base ref nor worktree metadata (which carries no branch).
  branch: string | null
  headSha: string | null
}

export function useMobilePrSidebarController(input: PrSidebarControllerInput) {
  const { client, connState, worktreeId, branch, headSha } = input
  // The dedicated PR icon is available whenever the repo has a GitHub remote —
  // independent of whether the branch has an open PR (a no-PR branch shows an
  // empty state rather than hiding the icon).
  const [isGithubRepo, setIsGithubRepo] = useState(false)
  const [state, setState] = useState<PrSidebarState>({ kind: 'hidden' })
  const [showPRSidebar, setShowPRSidebar] = useState(false)
  const loadSeqRef = useRef(0)

  const ready = client !== null && connState === 'connected' && !!branch

  const buildDeps = useCallback((): PrSidebarLoadDeps | null => {
    if (!client) {
      return null
    }
    return {
      fetchForBranch: (wt, args) => fetchHostedReviewForBranch(client, wt, args),
      fetchWorktreeLinkedPR: (wt) => fetchWorktreeLinkedPR(client, wt),
      fetchPRForBranch: (wt, args) => fetchPRForBranch(client, wt, args),
      fetchWorkItemDetails: (wt, args) => fetchWorkItemDetails(client, wt, args),
      fetchPRChecks: (wt, args) => fetchPRChecks(client, wt, args)
    }
  }, [client])

  // Probe whether this is a GitHub repo to decide icon availability (GitHub-only).
  useEffect(() => {
    let cancelled = false
    if (!ready || !client) {
      setIsGithubRepo(false)
      return
    }
    void fetchGithubRepoSlug(client, worktreeId).then((outcome) => {
      if (!cancelled) {
        setIsGithubRepo(outcome.ok && outcome.result !== null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [ready, client, worktreeId])

  const load = useCallback(async () => {
    const deps = buildDeps()
    if (!deps || !branch) {
      return
    }
    const seq = loadSeqRef.current + 1
    loadSeqRef.current = seq
    setState({ kind: 'loading' })
    // Phase 1: PR + checks (fast) — the worktree linkedPR read is parallelized with
    // forBranch inside loadPrSidebarData so a closed/merged linked PR still resolves.
    const next = await loadPrSidebarData(deps, { worktreeId, branch, headSha })
    if (!shouldApplyResult(seq, loadSeqRef.current)) {
      return
    }
    setState(next)
    if (next.kind !== 'ready') {
      return
    }
    // Phase 2: lazy-load the heavy comments/body payload and merge it in, so it never
    // blocks the actionable PR UI. Re-check the seq so a newer load isn't clobbered.
    const details = await loadPrSidebarDetails(deps, worktreeId, next.data.pr.number)
    if (shouldApplyResult(seq, loadSeqRef.current)) {
      setState({ kind: 'ready', data: { ...next.data, details } })
    }
  }, [buildDeps, branch, headSha, worktreeId])

  const openPRSidebar = useCallback(() => {
    setShowPRSidebar(true)
    // (Re)load on open unless we already have fresh PR data showing.
    if (state.kind !== 'ready' && state.kind !== 'loading') {
      void load()
    }
  }, [state.kind, load])

  return {
    prSidebarState: state,
    prSidebarIsGithubRepo: isGithubRepo,
    showPRSidebar,
    setShowPRSidebar,
    openPRSidebar,
    retryPRSidebar: load,
    refetchPRSidebar: load
  }
}
