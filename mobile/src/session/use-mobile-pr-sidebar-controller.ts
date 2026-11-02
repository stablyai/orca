import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { GitHubPRFileViewedState, PRInfo } from '../../../src/shared/github/pull-request-types'
import type { RpcClient } from '../transport/rpc-client'
import {
  backgroundReadFailed,
  keepShownChecks,
  useForegroundFirstLoad
} from './pr-sidebar-load-result'
import { fetchGithubRepoSlug } from './github-pr-rpc'
import { buildPrSidebarLoadDeps } from './pr-sidebar-load-deps'
import {
  loadPrSidebarData,
  loadPrSidebarDetails,
  prSidebarReviewKey,
  prSidebarDetailsNeedFetch,
  resolvePrSidebarDetailsAfterPhase2,
  shouldApplyResult,
  shouldSoftRefreshPrSidebarOnHeadChange,
  type PrSidebarLoadDeps,
  type PrSidebarState
} from './mobile-pr-sidebar-state'

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
  /** A poll the user did not ask for: a failed read leaves the shown PR in place. */
  background?: boolean
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
  // Claim in-flight details by sequence and review (repo + number) to dedupe cold segment opens.
  const detailsInFlightRef = useRef<{ seq: number; review: string } | null>(null)
  const stateIdentityRef = useRef<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const headShaRef = useRef(headSha)

  // Detached HEAD still needs repo eligibility; branching the probe would strand its spinner.
  const probeReady = client !== null && connState === 'connected'
  const identity = buildMobilePrSidebarIdentity({ worktreeId, branch })
  // Live identity, so a load closure captured for an earlier branch cannot claim the current one.
  const identityRef = useRef(identity)
  identityRef.current = identity

  const buildDeps = useCallback(() => (client ? buildPrSidebarLoadDeps(client) : null), [client])

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

  // Phase two, claimed by its own sequence so chip refreshes (which advance loadSeq) cannot replace its owner.
  const loadDetails = useCallback(
    async (deps: PrSidebarLoadDeps, pr: PRInfo, loadIdentity: string): Promise<void> => {
      const review = prSidebarReviewKey(pr)
      const detailsSeq = detailsSeqRef.current + 1
      detailsSeqRef.current = detailsSeq
      detailsInFlightRef.current = { seq: detailsSeq, review }
      const fetchedDetails = await loadPrSidebarDetails(deps, worktreeId, pr.number)
      // Release only this details claim; a newer load may already own it.
      if (detailsInFlightRef.current?.seq === detailsSeq) {
        detailsInFlightRef.current = null
      }
      const current = stateRef.current
      if (
        detailsSeq !== detailsSeqRef.current ||
        stateIdentityRef.current !== loadIdentity ||
        current.kind !== 'ready' ||
        prSidebarReviewKey(current.data.pr) !== review
      ) {
        return
      }
      // Replace nonfatal null with a placeholder so details cannot spin forever.
      const details = resolvePrSidebarDetailsAfterPhase2({
        fetched: fetchedDetails,
        prior: current.data.details,
        pr: current.data.pr
      })
      setState({ kind: 'ready', data: { ...current.data, details } })
    },
    [worktreeId]
  )

  const loadOnce = useCallback(
    async (options?: PrSidebarLoadOptions, afterWrite = false) => {
      const includeDetails = options?.includeDetails ?? true
      const deps = buildDeps()
      const loadIdentity = identity
      if (!deps || !branch || !loadIdentity || loadIdentity !== identityRef.current) {
        return 'stale'
      }
      // A details read started before the write would land pre-write content after this reread.
      const retiredDetails = afterWrite && detailsInFlightRef.current !== null
      if (afterWrite) {
        detailsSeqRef.current += 1
        detailsInFlightRef.current = null
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
      const read = await loadPrSidebarData(deps, { worktreeId, branch, headSha })
      if (
        !shouldApplyResult(seq, loadSeqRef.current) ||
        stateIdentityRef.current !== loadIdentity
      ) {
        return 'stale'
      }
      const keepShown = options?.background || afterWrite
      const shown = stateRef.current
      if (keepShown && backgroundReadFailed(shown, read)) {
        // The shown PR stays, so replace the details read this reread retired rather than leave it spinning.
        if (retiredDetails && shown.kind === 'ready') {
          await loadDetails(deps, shown.data.pr, loadIdentity)
        }
        return 'failed'
      }
      const next = keepShown ? keepShownChecks(shown, read) : read
      const landed = next === read ? 'applied' : 'failed'
      stateIdentityRef.current = loadIdentity

      // Keep prior details across phase one so refresh cannot blank the comment tree.
      const priorDetails =
        next.kind === 'ready' &&
        shown.kind === 'ready' &&
        shown.data.details != null &&
        prSidebarReviewKey(shown.data.pr) === prSidebarReviewKey(next.data.pr)
          ? shown.data.details
          : null

      if (next.kind === 'ready' && priorDetails != null) {
        setState({ kind: 'ready', data: { ...next.data, details: priorDetails } })
        if (!includeDetails) {
          return landed
        }
      } else {
        setState(next)
        if (next.kind !== 'ready' || !includeDetails) {
          return next.kind === 'ready' || next.kind === 'none' ? landed : 'failed'
        }
      }

      await loadDetails(deps, next.data.pr, loadIdentity)
      return landed
    },
    [buildDeps, branch, headSha, identity, loadDetails, worktreeId]
  )

  const { load, rereadAfterWrite } = useForegroundFirstLoad(loadOnce)

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
    const inFlight = detailsInFlightRef.current
    if (
      inFlight &&
      inFlight.review === prSidebarReviewKey(current.data.pr) &&
      inFlight.seq === detailsSeqRef.current
    ) {
      return
    }
    await loadDetails(deps, current.data.pr, loadIdentity)
  }, [buildDeps, identity, loadDetails])

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

  // Desktop's patchCachedPRFileViewedState: a viewed tick shows at once, and a failed write puts the old state back.
  const patchPrFileViewed = useCallback(
    (pullRequestId: string, path: string, viewed: GitHubPRFileViewedState) => {
      setState((prev) => {
        const files = prev.kind === 'ready' ? prev.data.details?.files : undefined
        // A write for one PR must not land on another the workspace was relinked to meanwhile.
        if (
          prev.kind !== 'ready' ||
          !prev.data.details ||
          !files ||
          prev.data.details.pullRequestId !== pullRequestId
        ) {
          return prev
        }
        return {
          kind: 'ready',
          data: {
            ...prev.data,
            details: {
              ...prev.data.details,
              files: files.map((file) =>
                file.path === path ? { ...file, viewerViewedState: viewed } : file
              )
            }
          }
        }
      })
    },
    []
  )

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
    // Every attempted PR write's follow-up read; its outcome stays the write's own feedback.
    rereadPRSidebarAfterWrite: rereadAfterWrite,
    ensurePrSidebarDetails,
    patchPrFileViewed
  }
}

export type MobilePrSidebarController = ReturnType<typeof useMobilePrSidebarController>
