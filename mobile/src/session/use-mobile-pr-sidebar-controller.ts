import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import {
  fetchHostedReviewForBranch,
  fetchPRChecks,
  fetchPRForBranch,
  fetchWorkItemDetails
} from './github-pr-rpc'
import {
  loadPrSidebarData,
  resolvePrSidebarEligibility,
  shouldApplyResult,
  type PrSidebarEligibility,
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
  const [eligibility, setEligibility] = useState<PrSidebarEligibility>({ kind: 'hidden' })
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

  // Resolve trigger eligibility whenever the connection or branch changes. A
  // non-GitHub provider or a branch with no PR leaves the trigger hidden (KTD4).
  useEffect(() => {
    let cancelled = false
    if (!ready || !branch) {
      setEligibility({ kind: 'hidden' })
      return
    }
    const deps = buildDeps()
    if (!deps) {
      return
    }
    void resolvePrSidebarEligibility(deps, { worktreeId, branch }).then((next) => {
      if (!cancelled) {
        setEligibility(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [ready, branch, worktreeId, buildDeps])

  const load = useCallback(async () => {
    const deps = buildDeps()
    if (!deps || !branch || eligibility.kind !== 'eligible') {
      return
    }
    const seq = loadSeqRef.current + 1
    loadSeqRef.current = seq
    setState({ kind: 'loading' })
    const next = await loadPrSidebarData(deps, {
      worktreeId,
      branch,
      headSha,
      linkedPRNumber: eligibility.prNumber
    })
    // Stale-response guard: a slower earlier load must not clobber a newer one.
    if (shouldApplyResult(seq, loadSeqRef.current)) {
      setState(next)
    }
  }, [buildDeps, branch, headSha, worktreeId, eligibility])

  const openPRSidebar = useCallback(() => {
    if (eligibility.kind !== 'eligible') {
      return
    }
    setShowPRSidebar(true)
    if (state.kind === 'hidden' || state.kind === 'error' || state.kind === 'blocked') {
      void load()
    }
  }, [eligibility, state.kind, load])

  return {
    prSidebarState: state,
    prSidebarEligible: eligibility.kind === 'eligible',
    showPRSidebar,
    setShowPRSidebar,
    openPRSidebar,
    retryPRSidebar: load,
    refetchPRSidebar: load
  }
}
