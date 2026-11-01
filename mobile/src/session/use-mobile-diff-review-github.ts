import { useCallback, useEffect, useMemo, useState } from 'react'
import { translate } from '../i18n/mobile-i18n'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { fetchAddPRReviewComment, fetchSetPRFileViewed } from './github-pr-review-line-mutations'
import {
  applyMobileDiffReviewGitHubViewed,
  buildMobileDiffReviewGitHub,
  canCommentOnGitHub,
  gitHubViewedFile,
  type MobileDiffReviewGitHub
} from './mobile-diff-review-github'
import type {
  MobileDiffReviewQueueFilter,
  MobileDiffReviewQueueItem
} from './mobile-diff-review-queue'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import { isPrSidebarDetailsPlaceholder, prSidebarDetailsNeedFetch } from './mobile-pr-sidebar-state'
import type { MobilePrSidebarController } from './use-mobile-pr-sidebar-controller'

type Input = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  filter: MobileDiffReviewQueueFilter
  screenState: ReviewScreenState
  prSidebar: MobilePrSidebarController
  setActionError: (message: string | null) => void
}

/** The branch's GitHub pull request as the diff screen uses it: viewed state, threads and line comments. */
export function useMobileDiffReviewGitHub(input: Input) {
  const { client, connState, worktreeId, filter, screenState, prSidebar, setActionError } = input
  const {
    prSidebarState,
    prSidebarIsGithubRepo,
    refetchPRSidebar,
    ensurePrSidebarDetails,
    patchPrFileViewed
  } = prSidebar
  const wantsPullRequest = filter === 'branch' && prSidebarIsGithubRepo

  // Committed files are the PR's files, so load its details (threads, viewed state) with the screen.
  const sidebarKind = prSidebarState.kind
  const needsDetails =
    prSidebarState.kind === 'ready' && prSidebarDetailsNeedFetch(prSidebarState.data.details)
  useEffect(() => {
    if (!wantsPullRequest) {
      return
    }
    if (sidebarKind === 'hidden') {
      void refetchPRSidebar({ includeDetails: true })
    } else if (needsDetails) {
      void ensurePrSidebarDetails()
    }
  }, [ensurePrSidebarDetails, needsDetails, refetchPRSidebar, sidebarKind, wantsPullRequest])

  const localHeadOid =
    screenState.kind === 'ready'
      ? (screenState.branchCompare?.summary.headOid ?? screenState.status.head ?? null)
      : null
  const data = prSidebarState.kind === 'ready' ? prSidebarState.data : null
  const details =
    data?.details && !isPrSidebarDetailsPlaceholder(data.details) ? data.details : null
  const github = useMemo<MobileDiffReviewGitHub | null>(
    () =>
      wantsPullRequest && data && details
        ? buildMobileDiffReviewGitHub({
            prNumber: data.pr.number,
            prRepo: data.pr.prRepo ?? null,
            details,
            localHeadOid
          })
        : null,
    [data, details, localHeadOid, wantsPullRequest]
  )

  // Like desktop, a file whose viewed write is still in flight takes no second tick until it settles.
  const [pendingViewed, setPendingViewed] = useState<ReadonlySet<string>>(() => new Set())
  const applyViewed = useCallback(
    (queue: readonly MobileDiffReviewQueueItem[]) =>
      applyMobileDiffReviewGitHubViewed(queue, github),
    [github]
  )

  /**
   * Marks a PR file viewed on GitHub. Null when this file's viewed state lives on the phone; false
   * while the PR's details are still loading, so a tick is never saved where GitHub will replace it.
   */
  const setRemoteViewed = useCallback(
    (item: MobileDiffReviewQueueItem, nextViewed: boolean): Promise<boolean> | null => {
      // A failed details load leaves a placeholder; only a load still in flight waits.
      const detailsLoading =
        prSidebarState.kind === 'loading' ||
        (prSidebarState.kind === 'ready' && prSidebarState.data.details === null)
      if (wantsPullRequest && item.scope === 'branch' && detailsLoading) {
        return Promise.resolve(false)
      }
      const pullRequestId = github?.pullRequestId
      const file = gitHubViewedFile(github, item)
      if (!github || !pullRequestId || !file) {
        return null
      }
      if (pendingViewed.has(item.filePath)) {
        return Promise.resolve(false)
      }
      if (!client || connState !== 'connected') {
        setActionError(
          translate('session.useDiffReviewGitHub.waitingForDesktop', 'Waiting for desktop...')
        )
        return Promise.resolve(false)
      }
      const path = item.filePath
      const previous = file.viewerViewedState
      const setPending = (pending: boolean) =>
        setPendingViewed((prev) => {
          const next = new Set(prev)
          if (pending) {
            next.add(path)
          } else {
            next.delete(path)
          }
          return next
        })
      setPending(true)
      patchPrFileViewed(pullRequestId, path, nextViewed ? 'VIEWED' : 'UNVIEWED')
      return fetchSetPRFileViewed(client, worktreeId, {
        pullRequestId,
        path,
        viewed: nextViewed,
        prRepo: github.prRepo
      })
        .then((outcome) => {
          if (outcome.ok) {
            return true
          }
          if (previous) {
            patchPrFileViewed(pullRequestId, path, previous)
          }
          triggerError()
          setActionError(outcome.error)
          return false
        })
        .finally(() => setPending(false))
    },
    [
      client,
      connState,
      github,
      patchPrFileViewed,
      pendingViewed,
      prSidebarState,
      setActionError,
      wantsPullRequest,
      worktreeId
    ]
  )

  const commentOnGitHub = useCallback(
    async (args: {
      item: MobileDiffReviewQueueItem
      startLine: number
      line: number
      body: string
    }): Promise<{ ok: true } | { ok: false; error: string | null }> => {
      if (!client || !github?.headSha || !canCommentOnGitHub(github, args.item, args)) {
        return { ok: false, error: null }
      }
      const outcome = await fetchAddPRReviewComment(client, worktreeId, {
        prNumber: github.prNumber,
        commitId: github.headSha,
        path: args.item.filePath,
        line: args.line,
        startLine: args.startLine,
        body: args.body,
        prRepo: github.prRepo
      })
      if (!outcome.ok) {
        // The sheet is still open over the screen's banner, so the sheet shows this.
        triggerError()
        return { ok: false, error: outcome.error }
      }
      triggerSuccess()
      // Show the new thread under its line.
      void refetchPRSidebar({ includeDetails: true })
      return { ok: true }
    },
    [client, github, refetchPRSidebar, worktreeId]
  )

  return { github, applyViewed, setRemoteViewed, commentOnGitHub }
}
