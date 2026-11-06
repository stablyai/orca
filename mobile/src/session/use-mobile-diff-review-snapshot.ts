import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { translate } from '../i18n/mobile-i18n'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { readHostQueryLive, useHostQuery } from '../query/host-query'
import { hostQueryKey } from '../query/host-query-key'
import { gitStatusQuery, type GitStatusRead } from '../source-control/mobile-git-status-query'
import { useMobileSourceControlSettings } from '../source-control/mobile-source-control-settings'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { loadMobileDiffReviewCommitSnapshot } from './mobile-diff-review-commit-loader'
import type { MobileBranchCompareCache } from './mobile-diff-review-loaders'
import type { MobileDiffReviewQueueFilter } from './mobile-diff-review-queue'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import {
  startMobileDiffReviewSnapshot,
  withMobileDiffReviewBranch
} from './mobile-diff-review-snapshot-loader'

const NO_INPUT = {}
const AWAITING = Symbol('awaiting status')

// The branch section lists the compare's files; a worktree section shows without waiting for it.
function reviewNeedsBranchCompare(filter: MobileDiffReviewQueueFilter): boolean {
  return filter === 'branch' || filter === 'all'
}

type SnapshotInput = {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string
  worktreeId: string
  commitOid: string | null
  filter: MobileDiffReviewQueueFilter
  setActionError: (message: string | null) => void
}

// Review's files, notes and branch compare, built on the git.status entry Changes shares.
export function useMobileDiffReviewSnapshot(input: SnapshotInput) {
  const { client, connState, hostId, worktreeId, commitOid, filter, setActionError } = input
  const loadGenerationRef = useRef(0)
  const [screenState, setScreenState] = useState<ReviewScreenState>({ kind: 'loading' })
  // When the status read behind the shown queue landed; a worktree diff is reused only for the same read.
  const [statusRevision, setStatusRevision] = useState(0)
  // Bumped by an explicit reload whose status read came back unchanged, so the notes and compare are read again.
  const [reloadNonce, setReloadNonce] = useState(0)
  const { compareAgainstUpstream } = useMobileSourceControlSettings(
    hostId,
    client,
    connState
  ).settings

  const queryClient = useQueryClient()
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const target = useMemo(() => ({ exec, worktree: worktreeId }), [exec, worktreeId])
  const statusKey = useMemo(
    () => hostQueryKey(hostId, gitStatusQuery.family, target, NO_INPUT),
    [hostId, target]
  )
  // The same git.status entry Changes shows, so Review opened from it starts from those rows.
  const worktreeReview = worktreeId !== '' && commitOid === null && filter !== 'commit'
  const { data: statusRead } = useHostQuery(gitStatusQuery, { hostId, client }, target, NO_INPUT, {
    enabled: worktreeReview
  })
  // The status read the shown snapshot was built from; AWAITING while a build waits for its first read.
  const builtFromRef = useRef<GitStatusRead | typeof AWAITING | undefined>(undefined)
  // Reloads after a write wait for the rebuild they cause, so the screen's buttons match the new files.
  const buildWaitersRef = useRef<(() => void)[]>([])
  const settleWaiters = () => {
    for (const settle of buildWaitersRef.current.splice(0)) {
      settle()
    }
  }

  const cacheBranchCompare = useCallback<MobileBranchCompareCache>(
    async (key, read) => {
      const queryKey = hostQueryKey(hostId, 'git.branchCompare', target, key)
      const loaded = await queryClient.fetchQuery({ queryKey, queryFn: read })
      // Only a compare that landed for this head is worth reusing; cached status can trail a commit.
      if (loaded.result?.summary.headOid !== key.head) {
        queryClient.removeQueries({ queryKey, exact: true })
      }
      return loaded
    },
    [hostId, queryClient, target]
  )

  const buildSnapshot = useEffectEvent(async (status: GitStatusRead | undefined) => {
    const generation = loadGenerationRef.current + 1
    loadGenerationRef.current = generation
    const isCurrent = () => generation === loadGenerationRef.current
    try {
      if (!worktreeId) {
        setScreenState({
          kind: 'error',
          message: translate('session.useDiffReviewController.missingWorktree', 'Missing worktree')
        })
        return
      }
      // Shells from before commit diffs drop the commit param when they mount this route themselves.
      if (filter === 'commit' && !commitOid) {
        setScreenState({
          kind: 'unavailable',
          message: translate(
            'session.useDiffReviewController.commitMissing',
            'Update the Orca app to open commit files here.'
          )
        })
        return
      }
      // Keep an existing review through disconnects; only empty screens need the waiting state.
      const keepReady = (fallback: ReviewScreenState) => (prev: ReviewScreenState) =>
        prev.kind === 'ready' ? prev : fallback
      const fail = (err: unknown) => {
        if (isCurrent()) {
          // Failed reconnect reads must not destroy an already loaded review.
          setScreenState(
            keepReady({
              kind: 'error',
              message:
                err instanceof Error
                  ? err.message
                  : translate('session.useDiffReviewController.loadFailed', 'Unable to load review')
            })
          )
        }
      }
      if (!client || connState !== 'connected') {
        setScreenState(
          keepReady({
            kind: 'error',
            message: translate(
              'session.useDiffReviewController.waitingForDesktop',
              'Waiting for desktop...'
            )
          })
        )
        return
      }
      setScreenState(keepReady({ kind: 'loading' }))
      if (commitOid) {
        try {
          const nextState = await loadMobileDiffReviewCommitSnapshot(client, worktreeId, commitOid)
          if (isCurrent()) {
            setScreenState(nextState)
            setActionError(null)
          }
        } catch (err) {
          fail(err)
        }
        return
      }
      // Without a cached read, join the one the status query is making; the compare base starts alongside it.
      builtFromRef.current = status ?? AWAITING
      const statusInput = status
        ? Promise.resolve(status)
        : readHostQueryLive(queryClient, gitStatusQuery, { hostId, client }, target, NO_INPUT, {
            replace: false
          }).then(
            (read) => {
              if (isCurrent()) {
                builtFromRef.current = queryClient.getQueryData<GitStatusRead>(statusKey) ?? read
              }
              return read
            },
            (err: unknown) => {
              if (isCurrent()) {
                builtFromRef.current = undefined
              }
              throw err
            }
          )
      const { snapshot, branch } = startMobileDiffReviewSnapshot(client, worktreeId, {
        status: statusInput,
        compareAgainstUpstream,
        cacheBranchCompare
      })
      try {
        // The branch section lists the compare's files; a worktree section shows without it.
        const [state, loaded] = reviewNeedsBranchCompare(filter)
          ? await Promise.all([snapshot, branch])
          : [await snapshot, null]
        if (!isCurrent()) {
          return
        }
        setStatusRevision(queryClient.getQueryState(statusKey)?.dataUpdatedAt ?? 0)
        if (loaded) {
          setScreenState(withMobileDiffReviewBranch(state, loaded, worktreeId))
          setActionError(loaded.error ?? null)
          return
        }
        // Hold the shown compare until the new one lands.
        setScreenState((prev) =>
          prev.kind === 'ready'
            ? withMobileDiffReviewBranch(
                state,
                { result: prev.branchCompare, error: prev.branchError },
                worktreeId
              )
            : state
        )
        // A write waits for the files it changed, not for the branch compare.
        settleWaiters()
        const settled = await branch
        if (isCurrent()) {
          setScreenState((prev) => withMobileDiffReviewBranch(prev, settled, worktreeId))
          setActionError(settled.error ?? null)
        }
      } catch (err) {
        fail(err)
      }
    } finally {
      if (isCurrent()) {
        settleWaiters()
      }
    }
  })

  // Open, reconnect and explicit reloads read everything but status, which comes from the shared query.
  useEffect(() => {
    void buildSnapshot(
      worktreeReview ? queryClient.getQueryData<GitStatusRead>(statusKey) : undefined
    )
  }, [client, commitOid, connState, queryClient, reloadNonce, statusKey, worktreeReview])

  // A status read that changed what Changes shows rebuilds the snapshot; one in flight already brings its own.
  useEffect(() => {
    const built = builtFromRef.current
    if (worktreeReview && statusRead !== undefined && built !== AWAITING && statusRead !== built) {
      void buildSnapshot(statusRead)
    }
  }, [statusRead, worktreeReview])

  // The compare base is read when a snapshot is built; a later setting change rebuilds without re-reading status.
  const shownCompareSettingRef = useRef(compareAgainstUpstream)
  useEffect(() => {
    if (shownCompareSettingRef.current !== compareAgainstUpstream) {
      shownCompareSettingRef.current = compareAgainstUpstream
      setReloadNonce((nonce) => nonce + 1)
    }
  }, [compareAgainstUpstream])

  // A diff that failed is read again; a branch or commit diff's key would not change on its own.
  const retryFailedDiff = useCallback(() => {
    void queryClient.refetchQueries({
      queryKey: ['orca', hostId, 'git.diff', target],
      type: 'active',
      // A worktree diff is re-keyed by the rebuild's status read instead.
      predicate: (query) => {
        const params = query.queryKey[4]
        return (
          query.state.status === 'error' &&
          typeof params === 'object' &&
          params !== null &&
          'statusRevision' in params &&
          params.statusRevision === null
        )
      }
    })
  }, [hostId, queryClient, target])

  // After a write or Retry: read status live so Changes and this screen both see it, then rebuild.
  const loadReviewData = useCallback(async () => {
    const before = queryClient.getQueryData<GitStatusRead>(statusKey)
    // With no rows yet the rebuild reads status itself.
    if (!client || !worktreeReview || before === undefined) {
      setReloadNonce((nonce) => nonce + 1)
      retryFailedDiff()
      return
    }
    try {
      await readHostQueryLive(queryClient, gitStatusQuery, { hostId, client }, target, NO_INPUT, {
        replace: true
      })
    } catch {
      // The status query holds the failure; the rebuild below reports it.
    }
    const rebuilt = new Promise<void>((settle) => buildWaitersRef.current.push(settle))
    // A changed read rebuilds through the status effect; an unchanged one still re-reads the notes.
    if (queryClient.getQueryData<GitStatusRead>(statusKey) === before) {
      setReloadNonce((nonce) => nonce + 1)
    }
    retryFailedDiff()
    await rebuilt
  }, [client, hostId, queryClient, retryFailedDiff, statusKey, target, worktreeReview])

  return { screenState, setScreenState, statusRevision, target, loadReviewData }
}
