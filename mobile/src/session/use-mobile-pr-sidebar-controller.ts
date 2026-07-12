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
  // Head branch + SHA come from git.status (`branch`/`head`) via the review screen,
  // not the branchCompare base ref nor worktree metadata (which carries no branch).
  branch: string | null
  headSha: string | null
}

// Load options for the shared PR controller. The Source Control hub chip only needs
// phase 1 (PR + checks); phase 2 (comments/body) is heavy and should wait until the
// Pull Request segment is actually open.
export type PrSidebarLoadOptions = {
  includeDetails?: boolean
}

// Identity is worktree + branch only. Head SHA advances on every commit and must not
// wipe a ready chip/sidebar to "loading" — soft-refresh uses the new head instead.
export function buildMobilePrSidebarIdentity(args: {
  worktreeId: string
  branch: string | null
}): string | null {
  return args.branch ? `${args.worktreeId}\u0000${args.branch}` : null
}

export function useMobilePrSidebarController(input: PrSidebarControllerInput) {
  const { client, connState, worktreeId, branch, headSha } = input
  // The dedicated PR icon is available whenever the repo has a GitHub remote —
  // independent of whether the branch has an open PR (a no-PR branch shows an
  // empty state rather than hiding the icon).
  const [isGithubRepo, setIsGithubRepo] = useState(false)
  // False until the probe resolves for this worktree. Consumers gate "unavailable
  // for this provider" copy on it — isGithubRepo=false is meaningless mid-probe.
  const [repoProbeLoaded, setRepoProbeLoaded] = useState(false)
  const [state, setState] = useState<PrSidebarState>({ kind: 'hidden' })
  const [showPRSidebar, setShowPRSidebar] = useState(false)
  const loadSeqRef = useRef(0)
  // Phase-2-only fetches use a separate sequence so they cannot cancel a concurrent
  // phase-1 soft refresh (and vice versa) when chip bootstrap left details null.
  const detailsSeqRef = useRef(0)
  // The (seq, prNumber) of the phase-2 fetch currently in flight. The hub's
  // fill-in effect fires as soon as phase 1 renders ready with null details —
  // exactly when load()'s own phase 2 just started. Without this claim, every
  // cold PR-segment open fetched the heavy details payload twice.
  const detailsInFlightRef = useRef<{ seq: number; prNumber: number } | null>(null)
  const stateIdentityRef = useRef<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const headShaRef = useRef(headSha)

  // Repo eligibility (a GitHub remote) is independent of the branch, so the probe
  // must not require one: a detached HEAD / mid-rebase worktree (branch === null)
  // would otherwise never set repoProbeLoaded, stranding the PR segment on a
  // forever spinner instead of the "Current branch unavailable" state.
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

  // Probe whether this is a GitHub repo to decide icon availability (GitHub-only).
  // Worktree change must reset eligibility; a brief disconnect must not — otherwise
  // the hub shows "unavailable for this provider" and hides the chip mid-session.
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
        // Why: sendGithubPrRead already normalizes throws, but a cancelled
        // unmount + any unexpected rejection must not surface as LogBox.
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
      // Why: ready/loading data is scoped to branch. A branch switch must not let
      // the open panel keep rendering the previous PR as "fresh."
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
      // In-flight phase-2 work is NOT invalidated here: this load only takes phase-2
      // ownership when its own phase 2 actually starts (the bump below), so a load
      // superseded at the phase-1 guard can never orphan a detailsSeq and silently
      // discard the only details fetch. A stale ensure applying mid-phase-1 is safe —
      // its identity/number/kind guards only let matching details through.
      const previousIdentity = stateIdentityRef.current
      stateIdentityRef.current = loadIdentity
      // Soft refresh: same branch already showing ready/none stays visible while
      // checks re-fetch (head advanced after commit). Hard loading only on first load
      // or after a real identity wipe.
      const keepVisible =
        previousIdentity === loadIdentity &&
        (stateRef.current.kind === 'ready' ||
          stateRef.current.kind === 'none' ||
          stateRef.current.kind === 'loading')
      if (!keepVisible) {
        setState({ kind: 'loading' })
      }
      // Phase 1: PR + checks (fast) — the worktree linkedPR read is parallelized with
      // forBranch inside loadPrSidebarData so a closed/merged linked PR still resolves.
      const next = await loadPrSidebarData(deps, { worktreeId, branch, headSha })
      if (
        !shouldApplyResult(seq, loadSeqRef.current) ||
        stateIdentityRef.current !== loadIdentity
      ) {
        return
      }
      stateIdentityRef.current = loadIdentity

      // Keep prior comments/body visible across phase 1 when the same PR is still open.
      // loadPrSidebarData always returns details:null; without this, soft refresh and
      // PR-tab refresh blank the comment tree until phase 2 finishes.
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

      // Phase 2: refresh (or first-load) the heavy comments/body payload.
      const detailsSeq = detailsSeqRef.current + 1
      detailsSeqRef.current = detailsSeq
      detailsInFlightRef.current = { seq: detailsSeq, prNumber: next.data.pr.number }
      const fetchedDetails = await loadPrSidebarDetails(deps, worktreeId, next.data.pr.number)
      // Release the claim unless a newer phase-2 superseded it (never clear theirs).
      if (detailsInFlightRef.current?.seq === detailsSeq) {
        detailsInFlightRef.current = null
      }
      // Phase-2 ownership is encoded by detailsSeq + identity + PR number alone —
      // deliberately NOT by loadSeq: a chip-only soft refresh bumps loadSeq without
      // bumping detailsSeq, and must not discard the in-flight details it preserved
      // (ensure dedupes against this claim, so nothing would re-fetch them).
      if (
        detailsSeq !== detailsSeqRef.current ||
        stateIdentityRef.current !== loadIdentity ||
        stateRef.current.kind !== 'ready' ||
        stateRef.current.data.pr.number !== next.data.pr.number
      ) {
        return
      }
      // Non-fatal null must not leave details===null (UI treats that as forever-loading).
      const details = resolvePrSidebarDetailsAfterPhase2({
        fetched: fetchedDetails,
        prior: stateRef.current.data.details,
        pr: stateRef.current.data.pr
      })
      setState({ kind: 'ready', data: { ...stateRef.current.data, details } })
    },
    [buildDeps, branch, headSha, identity, worktreeId]
  )

  // Phase-2 only — used when the hub opens the PR segment after a chip-only load.
  // Uses detailsSeqRef (not loadSeqRef) so it cannot cancel a concurrent soft phase-1.
  // Retries synthetic placeholders too: a failed phase-2 installs non-null empty
  // details so Description/Comments leave the spinner, and without this ensure
  // would never re-fetch on tab re-open.
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
    // A live phase-2 fetch for this PR is already in flight (its claim still owns
    // the latest details seq) — do not start a duplicate.
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

  // Soft-refresh checks when HEAD advances on the same branch (post-commit).
  // Also restarts an in-flight phase-1 load so a mid-flight head advance is not
  // applied with a stale SHA (headShaRef would otherwise advance with no reload).
  useEffect(() => {
    if (headShaRef.current === headSha) {
      return
    }
    headShaRef.current = headSha
    // Identity was just wiped (branch/worktree switch): stateRef still holds the
    // pre-wipe state in this effect flush, which would start a load flavored for
    // the OLD surface (e.g. heavy details on the Changes tab). Let the owning
    // surface's hidden-state effects drive the first load for the new identity.
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
    // (Re)load on open unless we already have fresh PR data showing.
    if (
      stateIdentityRef.current !== identity ||
      (state.kind !== 'ready' && state.kind !== 'loading')
    ) {
      void load({ includeDetails: true })
    } else if (state.kind === 'ready' && prSidebarDetailsNeedFetch(state.data.details)) {
      // Retries phase-2 placeholders too (failed details load, not only null).
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
