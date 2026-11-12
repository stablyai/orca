import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import { fetchPRCheckDetails } from '../../source-control/review/github-pr-rpc'
import '../../source-control/review/github-pr-repo-slug'
import type { GitHubPrRepoSlug } from '../../source-control/review/github-pr-repo-slug'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { DetailEntry } from './PRCheckDetail'
import { prCheckKey } from './pr-checks-presentation'
import type { PrTabScope } from './pr-tab-requests'

const NO_DETAILS: Record<string, DetailEntry> = {}

// Check details outlive the Checks screen, so going back and in again does not refetch them; they belong to one
// PR incarnation, so a held read for fork A can never fill upstream B or a later A again.
export function usePrCheckRunDetails({
  owner: detailsOwner,
  client,
  worktreeId,
  prRepo
}: {
  owner: PrTabScope
  client: RpcClient | null
  worktreeId: string
  prRepo: GitHubPrRepoSlug | null
}) {
  const [detailsState, setDetailsState] = useState<{
    owner: PrTabScope
    entries: Record<string, DetailEntry>
  }>({ owner: detailsOwner, entries: {} })
  const checkDetails = detailsState.owner === detailsOwner ? detailsState.entries : NO_DETAILS
  // Read through a ref so the fetch starts here, not inside a state updater React may replay.
  const checkDetailsRef = useRef(checkDetails)
  useLayoutEffect(() => {
    checkDetailsRef.current = checkDetails
  })
  const ensureCheckDetail = useCallback(
    (check: PRCheckDetail) => {
      const key = prCheckKey(check)
      const existing = checkDetailsRef.current[key]
      // A failed read is retried on the next open; only loaded and in-flight reads are kept.
      if ((existing && existing.status !== 'error') || !client) {
        return
      }
      const loading: DetailEntry = { status: 'loading' }
      checkDetailsRef.current = { ...checkDetailsRef.current, [key]: loading }
      setDetailsState((prev) => ({
        owner: detailsOwner,
        entries: { ...(prev.owner === detailsOwner ? prev.entries : NO_DETAILS), [key]: loading }
      }))
      void fetchPRCheckDetails(client, worktreeId, {
        checkRunId: check.checkRunId,
        workflowRunId: check.workflowRunId,
        checkName: check.name,
        url: check.url,
        prRepo
      })
        .then((outcome): DetailEntry =>
          outcome.ok
            ? { status: 'loaded', details: outcome.result }
            : { status: 'error', message: outcome.error }
        )
        .catch((err: unknown): DetailEntry => ({ status: 'error', message: String(err) }))
        .then((entry) =>
          setDetailsState((current) =>
            current.owner === detailsOwner
              ? { owner: detailsOwner, entries: { ...current.entries, [key]: entry } }
              : current
          )
        )
    },
    [client, detailsOwner, prRepo, worktreeId]
  )

  return { checkDetails, ensureCheckDetail }
}
