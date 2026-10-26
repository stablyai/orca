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
  prSidebarDetailsNeedFetch,
  resolvePrSidebarDetailsAfterPhase2,
  shouldApplyResult,
  shouldSoftRefreshPrSidebarOnHeadChange,
  type PrSidebarLoadDeps,
  type PrSidebarState
} from './mobile-pr-sidebar-state'
import { fetchWorktreeLinkedPR } from '../source-control/mobile-pr-link'

type PrSidebarControllerInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  branch: string | null
  headSha: string | null
}

// Load body/comments only when the PR segment opens; the hub chip needs just PR/checks.
export type PrSidebarLoadOptions = {
  includeDetails?: boolean
}

// Keep HEAD out of identity: commits soft-refresh checks without clearing ready UI.
export function buildMobilePrSidebarIdentity(args: {
  worktreeId: string
  branch: string | null
}): string | null {
  return args.branch ? `${args.worktreeId}\u0000${args.branch}` : null
}

export function useMobilePrSidebarController(input: PrSidebarControllerInput) {
  const { client, connState, worktreeId, branch, headSha } = input
  const [isGithubRepo, setIsGithubRepo] = useState(false)
  // Wait for the probe before calling this repo unsupported.
  const [repoProbeLoaded, setRepoProbeLoaded] = useState(false)
  const [state, setState] = useState<PrSidebarState>({ kind: 'hidden' })
  const [showPRSidebar, setShowPRSidebar] = useState(false)
  const loadSeqRef = useRef(0)
  // Give details their own sequence so chip refreshes and details fetches cannot cancel each other.
  const detailsSeqRef = useRef(0)
  // Claim in-flight details by sequence and PR to dedupe cold segment opens.
  const detailsInFlightRef = useRef<{ seq: number; prNumber: number } | null>(null)
  const stateIdentityRef = useRef<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const headShaRef = useRef(headSha)

  // Detached HEAD still needs repo eligibility; branching the probe would strand its spinner.
  const probeReady = client !== null && connState === 'connected'
  const identity = buildMobilePrSidebarIdentity({ worktreeId, branch })

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

  // Reset eligibility on workspace change, but retain it through disconnects so the chip stays visible.
  useEffect(() => {
    setIsGithubRepo(false)
    setRepoProbeLoaded(false)
  }, [worktreeId])

  useEffect(() => {
    let cancelled = false
    if (!probeReady || !client) {
      return
    }
    void fetchGithubRepoSlug(client, worktreeId)
      .then((outcome) => {
        if (!cancelled) {
          setIsGithubRepo(outcome.ok && outcome.result !== null)
          setRepoProbeLoaded(true)
        }
      })
      .catch(() => {
        // Contain stray repo-probe rejection even during unmount.
        if (!cancelled) {
          setIsGithubRepo(false)
          setRepoProbeLoaded(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [probeReady, client, worktreeId])

  useEffect(() => {
    if (!identity) {
      loadSeqRef.current += 1
      detailsSeqRef.current += 1
      stateIdentityRef.current = null
      setState({ kind: 'hidden' })
      return
    }
    if (stateIdentityRef.current !== null && stateIdentityRef.current !== identity) {
      // Invalidate branch-scoped data immediately so a switched branch cannot show the previous PR as fresh.
      loadSeqRef.current += 1
      detailsSeqRef.current += 1
      stateIdentityRef.current = null
      setState({ kind: 'hidden' })
    }
  }, [identity])

  const load = useCallback(
    async (options?: PrSidebarLoadOptions) => {
      const includeDetails = options?.includeDetails ?? true
      const deps = buildDeps()
      const loadIdentity = identity
      if (!deps || !branch || !loadIdentity) {
        return
      }
      const seq = loadSeqRef.current + 1
      loadSeqRef.current = seq
      // Claim details only when this load starts fetching them; superseded phase-one loads must not orphan existing details.
      const previousIdentity = stateIdentityRef.current
      stateIdentityRef.current = loadIdentity
      // Refresh same-branch data in place; reserve loading state for first load or identity replacement.
      const keepVisible =
        previousIdentity === loadIdentity &&
        (stateRef.current.kind === 'ready' ||
          stateRef.current.kind === 'none' ||
          stateRef.current.kind === 'loading')
      if (!keepVisible) {
        setState({ kind: 'loading' })
      }
      const next = await loadPrSidebarData(deps, { worktreeId, branch, headSha })
      if (
        !shouldApplyResult(seq, loadSeqRef.current) ||
        stateIdentityRef.current !== loadIdentity
      ) {
        return
      }
      stateIdentityRef.current = loadIdentity

      // Keep prior details across phase one so refresh cannot blank the comment tree.
      const priorDetails =
        next.kind === 'ready' &&
        stateRef.current.kind === 'ready' &&
        stateRef.current.data.details != null &&
        stateRef.current.data.pr.number === next.data.pr.number
          ? stateRef.current.data.details
          : null

      if (next.kind === 'ready' && priorDetails != null) {
        setState({ kind: 'ready', data: { ...next.data, details: priorDetails } })
        if (!includeDetails) {
          return
        }
      } else {
        setState(next)
        if (next.kind !== 'ready' || !includeDetails) {
          return
        }
      }

      const detailsSeq = detailsSeqRef.current + 1
      detailsSeqRef.current = detailsSeq
      detailsInFlightRef.current = { seq: detailsSeq, prNumber: next.data.pr.number }
      const fetchedDetails = await loadPrSidebarDetails(deps, worktreeId, next.data.pr.number)
      // Release only this details claim; a newer load may already own it.
      if (detailsInFlightRef.current?.seq === detailsSeq) {
        detailsInFlightRef.current = null
      }
      // Guard details by their own sequence; chip refresh advances loadSeq without replacing their owner.
      if (
        detailsSeq !== detailsSeqRef.current ||
        stateIdentityRef.current !== loadIdentity ||
        stateRef.current.kind !== 'ready' ||
        stateRef.current.data.pr.number !== next.data.pr.number
      ) {
        return
      }
      // Replace nonfatal null with a placeholder so details cannot spin forever.
      const details = resolvePrSidebarDetailsAfterPhase2({
        fetched: fetchedDetails,
        prior: stateRef.current.data.details,
        pr: stateRef.current.data.pr
      })
      setState({ kind: 'ready', data: { ...stateRef.current.data, details } })
    },
    [buildDeps, branch, headSha, identity, worktreeId]
  )

  const ensurePrSidebarDetails = useCallback(async () => {
    const current = stateRef.current
    if (current.kind !== 'ready' || !prSidebarDetailsNeedFetch(current.data.details)) {
      return
    }
    const deps = buildDeps()
    const loadIdentity = identity
    if (!deps || !loadIdentity || stateIdentityRef.current !== loadIdentity) {
      return
    }
    const prNumber = current.data.pr.number
    const inFlight = detailsInFlightRef.current
    if (inFlight && inFlight.prNumber === prNumber && inFlight.seq === detailsSeqRef.current) {
      return
    }
    const detailsSeq = detailsSeqRef.current + 1
    detailsSeqRef.current = detailsSeq
    detailsInFlightRef.current = { seq: detailsSeq, prNumber }
    const fetchedDetails = await loadPrSidebarDetails(deps, worktreeId, prNumber)
    if (detailsInFlightRef.current?.seq === detailsSeq) {
      detailsInFlightRef.current = null
    }
    if (
      detailsSeq !== detailsSeqRef.current ||
      stateIdentityRef.current !== loadIdentity ||
      stateRef.current.kind !== 'ready' ||
      stateRef.current.data.pr.number !== prNumber
    ) {
      return
    }
    const details = resolvePrSidebarDetailsAfterPhase2({
      fetched: fetchedDetails,
      prior: stateRef.current.data.details,
      pr: stateRef.current.data.pr
    })
    setState({
      kind: 'ready',
      data: { ...stateRef.current.data, details }
    })
  }, [buildDeps, identity, worktreeId])

  // Restart same-branch reads on HEAD advance so their check lookup cannot keep a stale SHA.
  useEffect(() => {
    if (headShaRef.current === headSha) {
      return
    }
    headShaRef.current = headSha
    // After identity reset the ref still holds old state; let the hidden-state effects start the new load.
    if (stateIdentityRef.current === null) {
      return
    }
    const current = stateRef.current
    if (!shouldSoftRefreshPrSidebarOnHeadChange(current.kind)) {
      return
    }
    void load({
      includeDetails: current.kind === 'ready' && current.data.details != null
    })
  }, [headSha, load])

  const openPRSidebar = useCallback(() => {
    setShowPRSidebar(true)
    if (
      stateIdentityRef.current !== identity ||
      (state.kind !== 'ready' && state.kind !== 'loading')
    ) {
      void load({ includeDetails: true })
    } else if (state.kind === 'ready' && prSidebarDetailsNeedFetch(state.data.details)) {
      void ensurePrSidebarDetails()
    }
  }, [identity, state, load, ensurePrSidebarDetails])

  const retry = useCallback(() => {
    void load({ includeDetails: true })
  }, [load])

  return {
    prSidebarState: state,
    prSidebarIsGithubRepo: isGithubRepo,
    prSidebarRepoProbeLoaded: repoProbeLoaded,
    showPRSidebar,
    setShowPRSidebar,
    openPRSidebar,
    retryPRSidebar: retry,
    refetchPRSidebar: load,
    ensurePrSidebarDetails
  }
}

export type MobilePrSidebarController = ReturnType<typeof useMobilePrSidebarController>
