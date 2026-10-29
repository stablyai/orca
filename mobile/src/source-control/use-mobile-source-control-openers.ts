import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import { translate } from '../i18n/mobile-i18n'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import type { RpcClient } from '../transport/rpc-client'
import { isRendererUnavailableReply } from '../transport/renderer-unavailable-reply'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { ConnectionState } from '../transport/types'
import { triggerError, triggerSelection } from '../platform/haptics'
import { useMobileBranchDiffPreview } from './use-mobile-branch-diff-preview'
import {
  canOpenMobileGitStatusEntry,
  isMobileGitUnavailableReply,
  type MobileGitStatusEntry
} from './mobile-git-status'
import { sourceFileDiffOpenRun, sourceFileOpenRun } from './mobile-source-file-open-operations'
import { buildMobileReviewFileRoute, type MobileReviewRouteArea } from './mobile-review-route'
import { revealMobileSourceControlSessionDiff } from './reveal-mobile-source-control-session-diff'
import type { MobileBranchCompareState } from './mobile-source-control-screen-state'

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  diffShowWhitespace: boolean
  hostId: string
  worktreeId: string
  name: string
  origin: string
  embedded: boolean
  onRequestClose?: () => void
  // Capture the active tab synchronously at tap time; after-await capture could mistake a later tab pick for the original.
  onFileOpenStart?: () => void
  onOpenedFileDiff?: (relativePath: string) => void
  branchCompareState: MobileBranchCompareState
  mountedRef: MutableRefObject<boolean>
  busyActionRef: MutableRefObject<string | null>
  setActionError: (message: string | null) => void
}

export function useMobileSourceControlOpeners(params: Params) {
  const {
    client,
    connState,
    diffShowWhitespace,
    hostId,
    worktreeId,
    name,
    origin,
    embedded,
    onRequestClose,
    onFileOpenStart,
    onOpenedFileDiff,
    branchCompareState,
    mountedRef,
    busyActionRef,
    setActionError
  } = params
  // Use the handoff seam: routes the embedded page cannot render belong to the native app.
  const router = useWorkspaceRouteHandoff()
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const openingPathRef = useRef<string | null>(null)

  const openReviewScreen = useCallback(
    (filePath: string, area: MobileReviewRouteArea) => {
      triggerSelection()
      router.push(
        buildMobileReviewFileRoute({
          hostId,
          worktreeId,
          worktreeName: name,
          filePath,
          area
        })
      )
    },
    [hostId, name, router, worktreeId]
  )

  const openFile = useCallback(
    async (entry: MobileGitStatusEntry) => {
      // Deletions can open pre-delete diffs; only unresolved conflicts are blocked, matching row capabilities.
      if (!canOpenMobileGitStatusEntry(entry) || entry.area === undefined) {
        return
      }
      if (openingPathRef.current || busyActionRef.current) {
        return
      }
      if (!client || connState !== 'connected') {
        if (!mountedRef.current) {
          return
        }
        setActionError(
          translate('sourceControl.openers.waitingForDesktop', 'Waiting for desktop...')
        )
        return
      }
      openingPathRef.current = entry.path
      setOpeningPath(entry.path)
      try {
        setActionError(null)
        if (origin !== 'session') {
          openReviewScreen(entry.path, entry.area)
          return
        }
        onFileOpenStart?.()
        const diffReply = await sourceFileDiffOpenRun.request(client, {
          worktree: `id:${worktreeId}`,
          relativePath: entry.path,
          staged: entry.area === 'staged'
        })
        // Headless hosts have no editor tabs; use git.diff on the review screen.
        if (isRendererUnavailableReply(diffReply)) {
          if (mountedRef.current) {
            openReviewScreen(entry.path, entry.area)
          }
          return
        }
        // Inspect refusal code to fall back when older hosts cannot open diff tabs.
        const fallbackToEdit = isMobileGitUnavailableReply(diffReply)
        const openedTabMode: 'diff' | 'edit' = fallbackToEdit ? 'edit' : 'diff'
        const editReply = fallbackToEdit
          ? await sourceFileOpenRun.request(client, {
              worktree: `id:${worktreeId}`,
              relativePath: entry.path
            })
          : undefined
        try {
          if (editReply) {
            sourceFileOpenRun.interpret(editReply)
          } else {
            sourceFileDiffOpenRun.interpret(diffReply)
          }
        } catch (error) {
          throw new Error(
            refusedRpcMessageOrFallback(
              error,
              translate('sourceControl.openers.openDiffFailed', 'Unable to open diff')
            )
          )
        }
        if (!mountedRef.current) {
          return
        }
        const revealResult = await revealMobileSourceControlSessionDiff({
          client,
          worktreeId,
          relativePath: entry.path,
          tabMode: openedTabMode,
          staged: entry.area === 'staged',
          onOpenedFileDiff,
          isCurrent: () => mountedRef.current && openingPathRef.current === entry.path
        })
        if (revealResult === 'cancelled') {
          return
        }
        if (revealResult === 'timeout') {
          throw new Error(
            translate(
              'sourceControl.openers.tabNotReady',
              "The file opened, but its tab isn't ready yet. Try again."
            )
          )
        }
        triggerSelection()
        // Embedded panels dismiss their dock; route panels pop back to the activated diff, with Back as the unwired-dock fallback.
        if (embedded) {
          ;(onRequestClose ?? (() => router.back()))()
        } else {
          router.back()
        }
      } catch (err) {
        if (!mountedRef.current) {
          return
        }
        triggerError()
        setActionError(
          err instanceof Error
            ? err.message
            : translate('sourceControl.openers.openDiffFailed', 'Unable to open diff')
        )
      } finally {
        if (openingPathRef.current === entry.path) {
          openingPathRef.current = null
          if (mountedRef.current) {
            setOpeningPath(null)
          }
        }
      }
    },
    [
      busyActionRef,
      client,
      connState,
      embedded,
      mountedRef,
      onFileOpenStart,
      onOpenedFileDiff,
      onRequestClose,
      openReviewScreen,
      origin,
      router,
      setActionError,
      worktreeId
    ]
  )

  const { branchDiffPreview, setBranchDiffPreview, openingBranchPath, openBranchDiff } =
    useMobileBranchDiffPreview({
      client,
      connState,
      diffShowWhitespace,
      hostId,
      worktreeId,
      origin,
      branchCompareState,
      mountedRef,
      busyActionRef,
      openingPathRef,
      setActionError,
      openReviewScreen
    })

  return {
    router,
    branchDiffPreview,
    setBranchDiffPreview,
    openingPath,
    openingBranchPath,
    openFile,
    openBranchDiff
  }
}
