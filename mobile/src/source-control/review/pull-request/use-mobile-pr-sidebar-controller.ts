import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { GitHubPRFileViewedState } from '../../../../../src/shared/github/pull-requests/pull-request-types'
import { useWorkspaceExecutionHost } from '../../../navigation/workspace-execution-host'
import { readHostQueryLive, useHostQuery } from '../../../query/host-query'
import { isHostNotConnectedError } from '../../../query/host-query-errors'
import { useLastShownData } from '../../../query/use-last-shown-data'
import { hostQueryKey } from '../../../query/host-query-key'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../transport/connection/connection-state'
import {
  githubRepoSlugQuery,
  NO_BRANCH,
  NO_CHECKS,
  NO_PR,
  patchPrDetails,
  prBranchReviewQuery,
  prChecksQuery,
  prDetailsQuery,
  prDetailsRepo,
  prRepoParams,
  type PrChecksInput,
  type PrDetailsInput,
  type PrQueryScope,
  type PrSlice
} from './mobile-pr-queries'
import {
  emptyPrSidebarDetails,
  prSidebarFailureState,
  prSidebarResourceKey,
  type PrSidebarState
} from './mobile-pr-sidebar-state'

export type PrSidebarControllerInput = {
  hostId: string
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  branch: string | null
  headSha: string | null
  /** What the screen always shows; other parts load when asked for. */
  demand?: 'summary' | 'details'
}

export type PrSidebarLoadOptions = {
  // Body and comments load only once a PR screen shows them; the hub chip needs just the PR and its checks.
  includeDetails?: boolean
  /** The user's explicit Refresh: every part is read again, past the host's caches. */
  refresh?: boolean
}

const NO_INPUT = {}

// Keep HEAD out of identity: a commit re-reads the PR without clearing what is shown.
export function buildMobilePrSidebarIdentity(args: {
  worktreeId: string
  branch: string | null
}): string | null {
  return args.branch ? `${args.worktreeId}\u0000${args.branch}` : null
}

// A read the host refused; a dropped connection is not one, the connected edge reads again.
function readFailed(query: UseQueryResult<unknown>): boolean {
  return query.isError && !isHostNotConnectedError(query.error)
}

export function useMobilePrSidebarController(input: PrSidebarControllerInput) {
  const { hostId, client, worktreeId, branch, headSha } = input
  const queryClient = useQueryClient()
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const target = useMemo(() => ({ exec, worktree: worktreeId }), [exec, worktreeId])
  const host = useMemo(() => ({ hostId, client }), [hostId, client])
  const identity = buildMobilePrSidebarIdentity(input)
  const scope = identity && `${hostId}\u0000${exec}\u0000${identity}`

  // Nothing is read until a screen asks, and each branch is asked again; asking for details includes the PR.
  const [demand, setDemand] = useState<{ scope: string | null; details: boolean } | null>(null)
  const raised = demand?.scope === scope ? demand : null
  const demanded = raised !== null || input.demand !== undefined
  const detailsDemanded = raised?.details === true || input.demand === 'details'
  const raiseDemand = useCallback(
    (details: boolean) =>
      setDemand((current) =>
        current?.scope === scope && (current.details || !details) ? current : { scope, details }
      ),
    [scope]
  )
  const [showPRSidebar, setShowPRSidebar] = useState(false)

  // Detached HEAD still needs repo eligibility, so the probe does not wait for a branch.
  const slugQuery = useHostQuery(githubRepoSlugQuery, host, target, NO_INPUT, {
    enabled: worktreeId !== ''
  })
  const isGithubRepo = slugQuery.data === true
  const probeLoaded = slugQuery.data !== undefined || readFailed(slugQuery)

  const branchInput = useMemo(() => (branch ? { branch, head: headSha } : null), [branch, headSha])
  const reviewQuery = useHostQuery(prBranchReviewQuery, host, target, branchInput ?? NO_BRANCH, {
    enabled: demanded && isGithubRepo && branchInput !== null
  })
  const review = useLastShownData(reviewQuery.data, scope)
  const pr = review?.kind === 'found' ? review.pr : null
  const resource = pr ? prSidebarResourceKey(pr) : null

  const checksInput = useMemo(
    (): PrChecksInput | null =>
      pr
        ? {
            ...prRepoParams(pr.prRepo),
            number: pr.number,
            // Creating a PR may first commit, so its fetched head is fresher than the cached git status.
            head: pr.headSha ?? headSha ?? null
          }
        : null,
    [pr, headSha]
  )
  const checksQuery = useHostQuery(prChecksQuery, host, target, checksInput ?? NO_CHECKS, {
    enabled: demanded && checksInput !== null
  })
  const checks = useLastShownData(
    checksQuery.data,
    scope && resource && `${scope}\u0000${resource}`
  )

  const detailsInput = useMemo((): PrDetailsInput | null => {
    const repository = pr ? prDetailsRepo(pr) : null
    return pr && repository ? { ...prRepoParams(repository), number: pr.number } : null
  }, [pr])
  const detailsQuery = useHostQuery(prDetailsQuery, host, target, detailsInput ?? NO_PR, {
    enabled: detailsDemanded && detailsInput !== null
  })

  // Details refetch only when the PR's updatedAt moved past what they were read at.
  const prUpdatedAt = pr?.updatedAt
  const detailsUpdatedAt = detailsQuery.data?.item.updatedAt
  const detailsReadAt = detailsQuery.dataUpdatedAt
  const reviewReadAt = reviewQuery.dataUpdatedAt
  useEffect(() => {
    if (
      detailsInput &&
      prUpdatedAt &&
      detailsUpdatedAt &&
      Date.parse(prUpdatedAt) > Date.parse(detailsUpdatedAt) &&
      // A details read after the summary already answered for this updatedAt; never loop on a host that disagrees.
      detailsReadAt < reviewReadAt
    ) {
      // A read already out (a Refresh's live one) answers for the new updatedAt; join it rather than restart it.
      void queryClient.invalidateQueries(
        {
          queryKey: hostQueryKey(hostId, prDetailsQuery.family, target, detailsInput),
          exact: true
        },
        { cancelRefetch: false }
      )
    }
  }, [
    detailsInput,
    detailsReadAt,
    detailsUpdatedAt,
    hostId,
    prUpdatedAt,
    queryClient,
    reviewReadAt,
    target
  ])

  const reviewFailed = readFailed(reviewQuery)
  const reviewError = reviewQuery.error
  const checksFailed = readFailed(checksQuery) && !checks
  const checksError = checksQuery.error
  const details = detailsQuery.data
  const detailsFailed = readFailed(detailsQuery)
  const shown = demanded && isGithubRepo && branch !== null
  const state = useMemo((): PrSidebarState => {
    if (!shown) {
      return { kind: 'hidden' }
    }
    if (!review) {
      return reviewFailed ? prSidebarFailureState(reviewError) : { kind: 'loading' }
    }
    // A failed read of a PR or no-PR result keeps it on screen, marked until a read succeeds.
    const marked = reviewFailed ? { refreshFailed: true as const } : {}
    if (review.kind === 'none') {
      return { kind: 'none', ...marked }
    }
    // The PR shows with its checks; a checks failure must not hide title, comments or merge controls.
    if (!checks && !checksFailed) {
      return { kind: 'loading' }
    }
    return {
      kind: 'ready',
      data: {
        pr: review.pr,
        // Null is still loading; a failed read finishes with a placeholder so spinners stop.
        details:
          details ?? (detailsDemanded && detailsFailed ? emptyPrSidebarDetails(review.pr) : null),
        checks: checks ?? [],
        checksError: checksFailed ? (checksError?.message ?? null) : null,
        pushTarget: review.pushTarget
      },
      ...marked
    }
  }, [
    shown,
    review,
    reviewFailed,
    reviewError,
    checks,
    checksFailed,
    checksError,
    details,
    detailsFailed,
    detailsDemanded
  ])

  const scopeQueries = useMemo(
    (): PrQueryScope => ({ host, target, branchInput, checksInput, detailsInput }),
    [host, target, branchInput, checksInput, detailsInput]
  )

  // A live read of each part a write or Refresh changed; failures keep what is shown.
  const rereadPRSlices = useCallback(
    async (slices: readonly PrSlice[]): Promise<void> => {
      // A repo without a GitHub remote has no PR to read, however the caller asks.
      if (!client || !isGithubRepo) {
        return
      }
      const live = { replace: true }
      const reader = { hostId, client }
      await Promise.allSettled([
        slices.includes('summary') && branchInput
          ? readHostQueryLive(queryClient, prBranchReviewQuery, reader, target, branchInput, live)
          : null,
        slices.includes('checks') && checksInput
          ? readHostQueryLive(queryClient, prChecksQuery, reader, target, checksInput, live)
          : null,
        slices.includes('details') && detailsInput
          ? readHostQueryLive(queryClient, prDetailsQuery, reader, target, detailsInput, live)
          : null
      ])
    },
    [branchInput, checksInput, client, detailsInput, hostId, isGithubRepo, queryClient, target]
  )

  const refetchPRSidebar = useCallback(
    async (options?: PrSidebarLoadOptions): Promise<void> => {
      const includeDetails = options?.includeDetails ?? true
      raiseDemand(includeDetails)
      // A first ask starts the reads by enabling them; a fresh cache answers without one.
      if (!demanded) {
        return
      }
      // Refresh reads every part; otherwise the summary, plus details a Retry asks for after they failed.
      const details = includeDetails && (options?.refresh || detailsFailed)
      await rereadPRSlices([
        'summary',
        ...(options?.refresh ? ['checks' as const] : []),
        ...(details ? ['details' as const] : [])
      ])
    },
    [demanded, detailsFailed, raiseDemand, rereadPRSlices]
  )

  // Asking for details only enables their read; a failed one is read again by Retry or Refresh, never in a loop.
  const ensurePrSidebarDetails = useCallback(() => raiseDemand(true), [raiseDemand])

  const openPRSidebar = useCallback(() => {
    // Opening is full demand even when loaded content needs no request now.
    raiseDemand(true)
    setShowPRSidebar(true)
  }, [raiseDemand])

  const retryPRSidebar = useCallback(() => {
    raiseDemand(true)
    void rereadPRSlices(['summary', 'checks', 'details'])
  }, [raiseDemand, rereadPRSlices])

  const refreshPRSidebarRepoProbe = useCallback(async (): Promise<boolean> => {
    if (!client || worktreeId === '') {
      return false
    }
    try {
      return await readHostQueryLive(
        queryClient,
        githubRepoSlugQuery,
        { hostId, client },
        target,
        NO_INPUT,
        { replace: false }
      )
    } catch {
      return false
    }
  }, [client, hostId, queryClient, target, worktreeId])

  // Desktop's patchCachedPRFileViewedState: a viewed tick shows at once, and a failed write puts the old state back.
  // A write for one PR never lands on another the workspace was relinked to meanwhile.
  const patchPrFileViewed = useCallback(
    (pullRequestId: string, path: string, viewed: GitHubPRFileViewedState) => {
      if (!detailsInput) {
        return
      }
      patchPrDetails(
        queryClient,
        hostQueryKey(hostId, prDetailsQuery.family, target, detailsInput),
        (details) =>
          details.files && details.pullRequestId === pullRequestId
            ? {
                ...details,
                files: details.files.map((file) =>
                  file.path === path ? { ...file, viewerViewedState: viewed } : file
                )
              }
            : details
      )
    },
    [detailsInput, hostId, queryClient, target]
  )

  return {
    prSidebarState: state,
    prSidebarIsGithubRepo: isGithubRepo,
    prSidebarRepoProbeLoaded: probeLoaded,
    prQueries: scopeQueries,
    refreshPRSidebarRepoProbe,
    showPRSidebar,
    setShowPRSidebar,
    openPRSidebar,
    retryPRSidebar,
    refetchPRSidebar,
    rereadPRSlices,
    ensurePrSidebarDetails,
    patchPrFileViewed
  }
}

export type MobilePrSidebarController = ReturnType<typeof useMobilePrSidebarController>
