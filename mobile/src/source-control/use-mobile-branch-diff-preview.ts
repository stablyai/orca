import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { triggerError, triggerSelection } from '../platform/haptics'
import { buildMobileDiffLines } from '../session/mobile-diff-lines'
import {
  highlightMobileDiffLines,
  resolveMobileSyntaxLanguage
} from '../session/mobile-file-syntax'
import {
  canOpenMobileBranchCompareDiff,
  type MobileGitBranchChangeEntry
} from './mobile-branch-compare'
import { gitBranchDiffRead } from './mobile-git-read-operations'
import type { MobileGitDiffReply } from './git-compare-reply-schema'
import type { MobileReviewRouteArea } from './mobile-review-route'
import type {
  MobileBranchCompareState,
  MobileBranchDiffPreviewState
} from './mobile-source-control-screen-state'

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string
  worktreeId: string
  origin: string
  branchCompareState: MobileBranchCompareState
  mountedRef: MutableRefObject<boolean>
  busyActionRef: MutableRefObject<string | null>
  openingPathRef: MutableRefObject<string | null>
  setActionError: (message: string | null) => void
  openReviewScreen: (path: string, area: MobileReviewRouteArea) => void
}

export function useMobileBranchDiffPreview({
  client,
  connState,
  hostId,
  worktreeId,
  origin,
  branchCompareState,
  mountedRef,
  busyActionRef,
  openingPathRef,
  setActionError,
  openReviewScreen
}: Params) {
  const [branchDiffPreview, updateBranchDiffPreview] =
    useState<MobileBranchDiffPreviewState | null>(null)
  const [openingBranchPath, setOpeningBranchPath] = useState<string | null>(null)
  const openingBranchPathRef = useRef<string | null>(null)
  const branchPreviewGeneration = useRef(0)
  const previewScope = useRef({ client, hostId, worktreeId })
  useLayoutEffect(() => {
    if (
      previewScope.current.client !== client ||
      previewScope.current.hostId !== hostId ||
      previewScope.current.worktreeId !== worktreeId
    ) {
      previewScope.current = { client, hostId, worktreeId }
      branchPreviewGeneration.current += 1
      openingBranchPathRef.current = null
      setOpeningBranchPath(null)
      updateBranchDiffPreview(null)
    }
  }, [client, hostId, worktreeId])
  const setBranchDiffPreview = useCallback((next: MobileBranchDiffPreviewState | null) => {
    if (next === null) {
      branchPreviewGeneration.current += 1
      openingBranchPathRef.current = null
      setOpeningBranchPath(null)
    }
    updateBranchDiffPreview(next)
  }, [])

  const openBranchDiff = useCallback(
    async (entry: MobileGitBranchChangeEntry) => {
      if (openingBranchPathRef.current || openingPathRef.current || busyActionRef.current) {
        return
      }
      if (!client || connState !== 'connected') {
        if (!mountedRef.current) {
          return
        }
        setActionError('Waiting for desktop...')
        return
      }
      if (branchCompareState.kind !== 'ready') {
        return
      }
      const summary = branchCompareState.result.summary
      if (!canOpenMobileBranchCompareDiff(summary) || !summary.headOid || !summary.mergeBase) {
        return
      }

      const generation = ++branchPreviewGeneration.current
      const isCurrentPreview = () =>
        mountedRef.current && branchPreviewGeneration.current === generation
      openingBranchPathRef.current = entry.path
      setOpeningBranchPath(entry.path)
      if (origin !== 'session') {
        openReviewScreen(entry.path, 'branch')
        openingBranchPathRef.current = null
        if (mountedRef.current) {
          setOpeningBranchPath(null)
        }
        return
      }
      updateBranchDiffPreview({ kind: 'loading', entry })
      try {
        const reply = await gitBranchDiffRead.request(client, {
          worktree: `id:${worktreeId}`,
          filePath: entry.path,
          ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
          compare: {
            baseRef: summary.baseRef,
            ...(summary.baseOid ? { baseOid: summary.baseOid } : {}),
            headOid: summary.headOid,
            mergeBase: summary.mergeBase
          }
        })
        let result: MobileGitDiffReply
        try {
          result = gitBranchDiffRead.interpret(reply)
        } catch (error) {
          throw new Error(refusedRpcMessageOrFallback(error, 'Unable to load committed diff'))
        }
        if (result.kind !== 'text') {
          throw new Error('Binary branch diff preview unavailable on mobile')
        }
        const diff = buildMobileDiffLines(result.originalContent, result.modifiedContent)
        const syntaxLanguage = resolveMobileSyntaxLanguage(entry.path)
        if (!isCurrentPreview()) {
          return
        }
        updateBranchDiffPreview({
          kind: 'ready',
          entry,
          summary,
          lines: highlightMobileDiffLines(diff.lines, syntaxLanguage),
          truncated: diff.truncated
        })
        triggerSelection()
      } catch (err) {
        if (!isCurrentPreview()) {
          return
        }
        triggerError()
        updateBranchDiffPreview({
          kind: 'error',
          entry,
          message: err instanceof Error ? err.message : 'Unable to load committed diff'
        })
      } finally {
        if (branchPreviewGeneration.current === generation) {
          openingBranchPathRef.current = null
          if (mountedRef.current) {
            setOpeningBranchPath(null)
          }
        }
      }
    },
    [
      branchCompareState,
      busyActionRef,
      client,
      connState,
      mountedRef,
      openReviewScreen,
      openingPathRef,
      origin,
      setActionError,
      worktreeId
    ]
  )

  return { branchDiffPreview, setBranchDiffPreview, openingBranchPath, openBranchDiff }
}
