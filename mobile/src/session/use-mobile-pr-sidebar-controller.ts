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
  shouldApplyResult,
  type PrSidebarLoadDeps,
  type PrSidebarState
} from './mobile-pr-sidebar-state'

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
    // forBranch (inside loadPrSidebarData) supplies the linked-PR hint; prForBranch
    // is authoritative and a branch with no PR resolves to the `none` empty state.
    const next = await loadPrSidebarData(deps, { worktreeId, branch, headSha })
    // Stale-response guard: a slower earlier load must not clobber a newer one.
    if (shouldApplyResult(seq, loadSeqRef.current)) {
      setState(next)
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
