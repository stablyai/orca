import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import {
  buildMobilePrSidebarIdentity,
  createRepoProbe,
  createSidebarObservation,
  subscribePrSidebarConnection,
  type PrSidebarControllerInput,
  type PrSidebarSelection
} from './mobile-pr-sidebar-observation'
import {
  fetchGithubRepoSlug,
  fetchHostedReviewForBranch,
  fetchPRChecks,
  fetchPRForBranch,
  fetchWorkItemDetails
} from './github-pr-rpc'
import {
  prSidebarResourceKey,
  loadPrSidebarData,
  loadPrSidebarDetails,
  prSidebarDetailsNeedFetch,
  resolvePrSidebarDetailsAfterPhase2,
  shouldApplyResult,
  shouldSoftRefreshPrSidebarOnHeadChange,
  type PrSidebarLoadDeps,
  type PrSidebarState
} from './mobile-pr-sidebar-state'
import {
  clearMobileWorktreeReviewLink,
  fetchWorktreeGitHubPRLink
} from '../source-control/mobile-pr-link'

// Load body/comments only when the PR segment opens; the hub chip needs just PR/checks.
export type PrSidebarLoadOptions = {
  includeDetails?: boolean
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
  const buildDeps = useCallback((): PrSidebarLoadDeps | null => {
    if (!client) {
      return null
    }
    return {
      fetchForBranch: (wt, args) => fetchHostedReviewForBranch(client, wt, args),
      fetchWorktreeGitHubPRLink: (wt) => fetchWorktreeGitHubPRLink(client, wt),
      clearWorktreeReviewLink: (wt, shouldApply) =>
        clearMobileWorktreeReviewLink(client, wt, shouldApply),
      fetchPRForBranch: (wt, args) => fetchPRForBranch(client, wt, args),
      fetchWorkItemDetails: (wt, args) => fetchWorkItemDetails(client, wt, args),
      fetchPRChecks: (wt, args) => fetchPRChecks(client, wt, args)
    }
  }, [client])

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

  const load = useCallback(
    async (options?: PrSidebarLoadOptions) => {
      const includeDetails = options?.includeDetails ?? true
      const deps = buildDeps()
      const loadIdentity = identity
      if (!owner.live || !deps || !branch || !loadIdentity) {
        return
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
        return
      }
      // A failed refresh is not a departure: keep the accepted PR or no-PR result and mark it until a good read.
      const accepted = owner.latest
      if (
        (next.kind === 'error' || next.kind === 'blocked') &&
        (accepted.kind === 'ready' || accepted.kind === 'none')
      ) {
        if (!accepted.refreshFailed) {
          publishState({ ...accepted, refreshFailed: true })
        }
        return
      }

      // Keep prior details across phase one so refresh cannot blank the comment tree.
      const priorDetails =
        next.kind === 'ready' &&
        owner.latest.kind === 'ready' &&
        owner.latest.data.details != null &&
        prSidebarResourceKey(owner.latest.data.pr) === prSidebarResourceKey(next.data.pr)
          ? owner.latest.data.details
          : null

      if (next.kind === 'ready' && priorDetails != null) {
        publishState({ kind: 'ready', data: { ...next.data, details: priorDetails } })
        if (!includeDetails) {
          return
        }
      } else {
        publishState(next)
        if (next.kind !== 'ready' || !includeDetails) {
          return
        }
      }

      const detailsSeq = owner.detailsSeq + 1
      owner.detailsSeq = detailsSeq
      owner.detailsInFlight = {
        seq: detailsSeq,
        resourceKey: prSidebarResourceKey(next.data.pr)
      }
      const fetchedDetails = await loadPrSidebarDetails(deps, worktreeId, next.data.pr)
      // Release only this details claim; a newer load may already own it.
      if (owner.detailsInFlight?.seq === detailsSeq) {
        owner.detailsInFlight = null
      }
      // Guard details by their own sequence; chip refresh advances loadSeq without replacing their owner.
      if (
        detailsSeq !== owner.detailsSeq ||
        !owner.live ||
        owner.latest.kind !== 'ready' ||
        prSidebarResourceKey(owner.latest.data.pr) !== prSidebarResourceKey(next.data.pr)
      ) {
        return
      }
      // Replace nonfatal null with a placeholder so details cannot spin forever.
      const details = resolvePrSidebarDetailsAfterPhase2({
        fetched: fetchedDetails,
        prior: owner.latest.data.details,
        pr: owner.latest.data.pr
      })
      // Details cannot certify the PR read, so a refresh failure stays marked.
      publishState({ ...owner.latest, data: { ...owner.latest.data, details } })
    },
    [buildDeps, branch, headSha, identity, worktreeId, owner, publishState]
  )

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
    const detailsSeq = owner.detailsSeq + 1
    owner.detailsSeq = detailsSeq
    owner.detailsInFlight = { seq: detailsSeq, resourceKey }
    const fetchedDetails = await loadPrSidebarDetails(deps, worktreeId, current.data.pr)
    if (owner.detailsInFlight?.seq === detailsSeq) {
      owner.detailsInFlight = null
    }
    if (
      detailsSeq !== owner.detailsSeq ||
      !owner.live ||
      owner.latest.kind !== 'ready' ||
      prSidebarResourceKey(owner.latest.data.pr) !== resourceKey
    ) {
      return
    }
    const details = resolvePrSidebarDetailsAfterPhase2({
      fetched: fetchedDetails,
      prior: owner.latest.data.details,
      pr: owner.latest.data.pr
    })
    publishState({ ...owner.latest, data: { ...owner.latest.data, details } })
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
    ensurePrSidebarDetails
  }
}

export type MobilePrSidebarController = ReturnType<typeof useMobilePrSidebarController>
