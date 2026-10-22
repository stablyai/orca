import { useCallback, useRef, useState, type MutableRefObject } from 'react'
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
  hostId: string
  worktreeId: string
  name: string
  origin: string
  embedded: boolean
  onRequestClose?: () => void
  // Fired synchronously at tap time (before the openDiff RPC) so the session can
  // snapshot the active tab then — capturing it post-await would misread a tab
  // the user switched to during the RPC window as the tap-time tab.
  onFileOpenStart?: () => void
  onOpenedFileDiff?: (relativePath: string) => void
  branchCompareState: MobileBranchCompareState
  mountedRef: MutableRefObject<boolean>
  busyActionRef: MutableRefObject<string | null>
  setActionError: (message: string | null) => void
}

// Owns opening a changed file (diff or session replace) and previewing a
// committed branch diff, plus the in-flight openingPath/openingBranchPath state.
export function useMobileSourceControlOpeners(params: Params) {
  const {
    client,
    connState,
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
  // The seam, not expo-router's own: inside the shell's page a push to a route the page does not
  // render has to be handed back to the app, and only this knows which targets those are.
  const router = useWorkspaceRouteHandoff()
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const openingPathRef = useRef<string | null>(null)

  const openReviewScreen = useCallback(
    (filePath: string, area: MobileReviewRouteArea) => {
      triggerSelection()
      router.push(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder only emits the declared /h/[hostId]/review/[worktreeId] route.
        buildMobileReviewFileRoute({
          hostId,
          worktreeId,
          worktreeName: name,
          filePath,
          area
        }) as Parameters<typeof router.push>[0]
      )
    },
    [hostId, name, router, worktreeId]
  )

  const openFile = useCallback(
    async (entry: MobileGitStatusEntry) => {
      // Deletions are openable (pre-delete text/image via git.diff); only block
      // unresolved conflicts, matching canOpenMobileGitStatusEntry / row UI.
      // An entry with no area is in no section, so no row can reach this anyway.
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
        setActionError('Waiting for desktop...')
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
        // Snapshot the active tab now, at tap time, before the openDiff RPC —
        // the session uses it to avoid stealing focus if the user switches tabs
        // during the RPC window.
        onFileOpenStart?.()
        const diffReply = await sourceFileDiffOpenRun.request(client, {
          worktree: `id:${worktreeId}`,
          relativePath: entry.path,
          staged: entry.area === 'staged'
        })
        // Why: a host with no desktop window opens no editor tabs; its diff still reads through git.diff on the review screen.
        if (isRendererUnavailableReply(diffReply)) {
          if (mountedRef.current) {
            openReviewScreen(entry.path, entry.area)
          }
          return
        }
        // Why the raw refusal: a host too old to open a diff tab is a capability gap this flow
        // falls back from, and no acceptance policy carries the code and message through.
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
          throw new Error(refusedRpcMessageOrFallback(error, 'Unable to open diff'))
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
          throw new Error("The file opened, but its tab isn't ready yet. Try again.")
        }
        triggerSelection()
        // Why: when launched from the session screen, opening a file dismisses
        // this surface back to the session. In embedded mode there is nothing
        // to pop (the panel docks beside the terminal), so close the dock
        // instead of calling router.back() — falling back to router.back() when
        // no close handler is wired, mirroring MobileSourceControlPanel, so the
        // panel never sits on top of the activated diff tab.
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
        setActionError(err instanceof Error ? err.message : 'Unable to open diff')
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
