import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { GitHubPRFileViewedState } from '../../../src/shared/github/pull-request-types'
import {
  buildMobilePrSidebarIdentity,
  createRepoProbe,
  createSidebarObservation,
  fetchCurrentPrSidebarDetails,
  prSidebarLoadDeps,
  prSidebarWithFileViewed,
  subscribePrSidebarConnection,
  type PrSidebarControllerInput,
  type PrSidebarSelection
} from './mobile-pr-sidebar-observation'
import { settleLoadedPr, useForegroundFirstLoad } from './pr-sidebar-load-result'
import { fetchGithubRepoSlug } from './github-pr-rpc'
import {
  prSidebarResourceKey,
  loadPrSidebarData,
  prSidebarDetailsNeedFetch,
  shouldApplyResult,
  shouldSoftRefreshPrSidebarOnHeadChange,
  type PrSidebarState
} from './mobile-pr-sidebar-state'

// Load body/comments only when the PR segment opens; the hub chip needs just PR/checks.
export type PrSidebarLoadOptions = {
  includeDetails?: boolean
  /** A poll the user did not ask for: a failed read leaves the shown PR in place. */
  background?: boolean
  /** The user's explicit Refresh, sent as a canonical details read; never kept as reconnect demand. */
  refresh?: boolean
}

export { buildMobilePrSidebarIdentity }

export function useMobilePrSidebarController(input: PrSidebarControllerInput) {
  const { client, connState, worktreeId, branch, headSha } = input
  const identity = buildMobilePrSidebarIdentity(input)
  const [selection, setSelection] = useState<PrSidebarSelection>(() => {
    const owner = createSidebarObservation(input)
    return { owner, snapshot: owner.latest, probe: createRepoProbe(worktreeId) }
  })
  const [showPRSidebar, setShowPRSidebar] = useState(false)
  let selected = selection
  if (
    selection.owner.client !== client ||
    selection.owner.worktreeId !== worktreeId ||
    selection.owner.identity !== identity
  ) {
    const owner = createSidebarObservation(input)
    selected = { ...selected, owner, snapshot: owner.latest }
  }
  if (selection.probe.owner.worktreeId !== worktreeId) {
    selected = { ...selected, probe: createRepoProbe(worktreeId) }
  }
  if (selected !== selection) {
    setSelection(selected)
  }
  const { owner, snapshot: state, probe } = selected
  const probeOwner = probe.owner

  useLayoutEffect(() => {
    owner.live = true
    return () => {
      owner.live = false
      owner.loadSeq += 1
      owner.detailsSeq += 1
      owner.detailsInFlight = null
    }
  }, [owner])

  // One committed reconciler retires attempts on connection changes and recovers in place.
  useLayoutEffect(() => subscribePrSidebarConnection(owner), [owner])

  const publishState = useCallback(
    (next: PrSidebarState) => {
      // A resource departure ends its details lifetime even if the same key later returns.
      const previous = owner.latest
      if (
        previous.kind === 'ready' &&
        (next.kind !== 'ready' ||
          prSidebarResourceKey(previous.data.pr) !== prSidebarResourceKey(next.data.pr))
      ) {
        owner.detailsSeq += 1
        owner.detailsInFlight = null
      }
      owner.latest = next
      setSelection((current) =>
        current.owner === owner ? { ...current, snapshot: next } : current
      )
    },
    [owner]
  )

  // Detached HEAD still needs repo eligibility; branching the probe would strand its spinner.
  const probeReady = client !== null && connState === 'connected'
  const buildDeps = useCallback(() => prSidebarLoadDeps(client), [client])

  useEffect(() => {
    let cancelled = false
    if (!probeReady || !client) {
      return
    }
    const publishProbe = (isGithubRepo: boolean) => {
      if (!cancelled) {
        setSelection((current) =>
          current.probe.owner === probeOwner
            ? { ...current, probe: { owner: probeOwner, isGithubRepo, loaded: true } }
            : current
        )
      }
    }
    void fetchGithubRepoSlug(client, worktreeId)
      .then((outcome) => publishProbe(outcome.ok && outcome.result !== null))
      .catch(() => {
        // Contain stray repo-probe rejection even during unmount.
        publishProbe(false)
      })
    return () => {
      cancelled = true
    }
  }, [probeReady, client, worktreeId, probeOwner])

  const loadOnce = useCallback(
    async (options?: PrSidebarLoadOptions, afterWrite = false) => {
      const includeDetails = options?.includeDetails ?? true
      const deps = buildDeps()
      const loadIdentity = identity
      if (!owner.live || !deps || !branch || !loadIdentity) {
        return 'stale'
      }
      // A details read started before the write would land pre-write content after this reread.
      const retiredDetails = afterWrite && owner.detailsInFlight !== null
      if (afterWrite) {
        owner.detailsSeq += 1
        owner.detailsInFlight = null
      }
      // A chip refresh never downgrades a full query this observation was already asked for.
      owner.demand = { includeDetails: includeDetails || owner.demand?.includeDetails === true }
      const seq = owner.loadSeq + 1
      owner.loadSeq = seq
      // Refresh this observation in place; a fresh scope begins hidden.
      const keepVisible =
        owner.latest.kind === 'ready' ||
        owner.latest.kind === 'none' ||
        owner.latest.kind === 'loading'
      if (!keepVisible) {
        publishState({ kind: 'loading' })
      }
      const next = await loadPrSidebarData(deps, { worktreeId, branch, headSha })
      if (!owner.live || !shouldApplyResult(seq, owner.loadSeq)) {
        return 'stale'
      }
      // A failed discovery, from any caller (a poll too), is not a departure: keep the accepted PR or no-PR result
      // and mark it until a current discovery succeeds; the poll backs off on 'failed'.
      const accepted = owner.latest
      if (
        (next.kind === 'error' || next.kind === 'blocked') &&
        (accepted.kind === 'ready' || accepted.kind === 'none')
      ) {
        if (!accepted.refreshFailed) {
          publishState({ ...accepted, refreshFailed: true })
        }
        // The shown PR stays, so replace the details read this reread retired rather than leave it spinning.
        if (retiredDetails && accepted.kind === 'ready') {
          const details = await fetchCurrentPrSidebarDetails({
            owner,
            deps,
            worktreeId,
            pr: accepted.data.pr
          })
          if (details && owner.latest.kind === 'ready') {
            publishState({ ...owner.latest, data: { ...owner.latest.data, details } })
          }
        }
        return 'failed'
      }
      // A poll or a write's reread keeps prior checks when that read failed for the same PR, and still lands
      // the new review state. Equal numbers in another repository are another PR.
      const { settled, result } = settleLoadedPr(
        accepted,
        next,
        options?.background === true || afterWrite
      )

      // Keep prior details across phase one so refresh cannot blank the comment tree.
      const priorDetails =
        settled.kind === 'ready' &&
        owner.latest.kind === 'ready' &&
        owner.latest.data.details != null &&
        prSidebarResourceKey(owner.latest.data.pr) === prSidebarResourceKey(settled.data.pr)
          ? owner.latest.data.details
          : null

      if (settled.kind === 'ready' && priorDetails != null) {
        publishState({ kind: 'ready', data: { ...settled.data, details: priorDetails } })
        if (!includeDetails) {
          return result
        }
      } else {
        publishState(settled)
        if (settled.kind !== 'ready' || !includeDetails) {
          return settled.kind === 'ready' || settled.kind === 'none' ? result : 'failed'
        }
      }

      const details = await fetchCurrentPrSidebarDetails({
        owner,
        deps,
        worktreeId,
        pr: settled.data.pr,
        refresh: options?.refresh
      })
      // Details cannot certify the PR read, so a refresh failure stays marked.
      if (details && owner.latest.kind === 'ready') {
        publishState({ ...owner.latest, data: { ...owner.latest.data, details } })
      }
      return result
    },
    [buildDeps, branch, headSha, identity, worktreeId, owner, publishState]
  )

  const { load, rereadAfterWrite } = useForegroundFirstLoad(loadOnce)

  const ensurePrSidebarDetails = useCallback(async () => {
    const current = owner.latest
    if (
      !owner.live ||
      current.kind !== 'ready' ||
      !prSidebarDetailsNeedFetch(current.data.details)
    ) {
      return
    }
    const deps = buildDeps()
    const loadIdentity = identity
    if (!deps || !loadIdentity) {
      return
    }
    owner.demand = { includeDetails: true }
    const resourceKey = prSidebarResourceKey(current.data.pr)
    const inFlight = owner.detailsInFlight
    if (inFlight && inFlight.resourceKey === resourceKey && inFlight.seq === owner.detailsSeq) {
      return
    }
    const details = await fetchCurrentPrSidebarDetails({
      owner,
      deps,
      worktreeId,
      pr: current.data.pr
    })
    if (details && owner.latest.kind === 'ready') {
      publishState({ ...owner.latest, data: { ...owner.latest.data, details } })
    }
  }, [buildDeps, identity, worktreeId, owner, publishState])

  // Restart same-branch reads on HEAD advance so their check lookup cannot keep a stale SHA.
  useEffect(() => {
    if (owner.headSha === headSha) {
      return
    }
    owner.headSha = headSha
    const current = owner.latest
    if (!shouldSoftRefreshPrSidebarOnHeadChange(current.kind)) {
      return
    }
    void load({
      includeDetails: current.kind === 'ready' && current.data.details != null
    })
  }, [headSha, load, owner])

  useLayoutEffect(() => {
    owner.recover = () => {
      if (owner.demand) {
        void load(owner.demand)
      }
    }
  }, [owner, load])

  const openPRSidebar = useCallback(() => {
    // Opening is full demand even when loaded content needs no request now.
    owner.demand = { includeDetails: true }
    setShowPRSidebar(true)
    if (state.kind !== 'ready' && state.kind !== 'loading') {
      void load({ includeDetails: true })
    } else if (state.kind === 'ready' && prSidebarDetailsNeedFetch(state.data.details)) {
      void ensurePrSidebarDetails()
    }
  }, [owner, state, load, ensurePrSidebarDetails])

  // Desktop's patchCachedPRFileViewedState: a viewed tick shows at once, and a failed write puts the old state back.
  const patchPrFileViewed = useCallback(
    (pullRequestId: string, path: string, viewed: GitHubPRFileViewedState) => {
      // A callback from a departed observation or for another PR changes nothing.
      const next = owner.live
        ? prSidebarWithFileViewed(owner.latest, pullRequestId, path, viewed)
        : null
      if (next) {
        publishState(next)
      }
    },
    [owner, publishState]
  )

  const retry = useCallback(() => {
    void load({ includeDetails: true })
  }, [load])

  return {
    prSidebarState: state,
    prSidebarIsGithubRepo: probe.isGithubRepo,
    prSidebarRepoProbeLoaded: probe.loaded,
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
