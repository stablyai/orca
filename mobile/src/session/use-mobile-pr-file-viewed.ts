import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  GitHubPRFile,
  GitHubPRFileViewedState
} from '../../../src/shared/github/pull-request-types'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { ConnectionState } from '../transport/types'
import type { GitHubPrRepoSlug } from './github-pr-repo-slug'
import { fetchSetPRFileViewed } from './github-pr-file-mutations'

/** Marks a file viewed at once in the loaded details and rolls it back if GitHub refuses. */
export function useMobilePrFileViewed(input: {
  client: RpcOperationSender | null
  connState: ConnectionState
  worktreeId: string
  prNumber: number
  pullRequestId: string | undefined
  prRepo: GitHubPrRepoSlug | null
  files: readonly GitHubPRFile[]
  setFileViewedState: (prNumber: number, path: string, state: GitHubPRFileViewedState) => void
}) {
  const { client, connState, worktreeId, prNumber, pullRequestId, prRepo, files } = input
  const { setFileViewedState } = input
  // Keyed by PR so a write still settling for the branch's previous PR never shows on the next one.
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<{ prNumber: number; message: string } | null>(null)
  const pendingRef = useRef<Set<string>>(new Set())

  const setPending = useCallback((key: string, pending: boolean) => {
    if (pending) {
      pendingRef.current.add(key)
    } else {
      pendingRef.current.delete(key)
    }
    setPendingKeys(new Set(pendingRef.current))
  }, [])
  const pendingPaths = useMemo(() => {
    const prefix = `${prNumber}\0`
    return new Set(
      [...pendingKeys]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
    )
  }, [pendingKeys, prNumber])

  const canSync = Boolean(client && pullRequestId && connState === 'connected')
  // Read files through a ref so a toggle does not hand every row a new callback.
  const filesRef = useRef(files)
  useEffect(() => {
    filesRef.current = files
  }, [files])

  const setViewed = useCallback(
    async (path: string, viewed: boolean): Promise<void> => {
      const key = `${prNumber}\0${path}`
      if (!client || !pullRequestId || connState !== 'connected' || pendingRef.current.has(key)) {
        return
      }
      const previous =
        filesRef.current.find((file) => file.path === path)?.viewerViewedState ?? 'UNVIEWED'
      const next: GitHubPRFileViewedState = viewed ? 'VIEWED' : 'UNVIEWED'
      setPending(key, true)
      setError(null)
      setFileViewedState(prNumber, path, next)
      try {
        const outcome = await fetchSetPRFileViewed(client, worktreeId, {
          pullRequestId,
          path,
          viewed,
          prRepo
        })
        // Re-apply on success: a refetch that landed mid-request may carry the old state.
        setFileViewedState(prNumber, path, outcome.ok ? next : previous)
        if (!outcome.ok) {
          setError({ prNumber, message: outcome.error })
        }
      } finally {
        setPending(key, false)
      }
    },
    [client, connState, prNumber, prRepo, pullRequestId, setFileViewedState, setPending, worktreeId]
  )

  return {
    setViewed,
    canSync,
    pendingPaths,
    error: error?.prNumber === prNumber ? error.message : null
  }
}

export type MobilePrFileViewed = ReturnType<typeof useMobilePrFileViewed>
