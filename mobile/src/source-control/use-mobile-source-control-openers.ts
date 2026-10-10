import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import { useRouteHandoff } from '../navigation/route-handoff'
import type { RpcClient } from '../transport/rpc-client'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { ConnectionState } from '../transport/types'
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
import { canOpenMobileGitStatusEntry, type MobileGitStatusEntry } from './mobile-git-status'
import { openSessionChangedFile } from './session-changed-file-open'
import { buildMobileReviewFileRoute, type MobileReviewRouteTarget } from './mobile-review-route'
import { revealMobileSourceControlSessionDiff } from './reveal-mobile-source-control-session-diff'
import type {
  MobileBranchCompareState,
  MobileBranchDiffPreviewState
} from './mobile-source-control-screen-state'
import type { MobileGitDiffReply } from './git-compare-reply-schema'

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
  onFileOpenStart?: () => (() => boolean) | void
  onOpenedFileDiff?: (relativePath: string) => void
  branchCompareState: MobileBranchCompareState
  mountedRef: MutableRefObject<boolean>
  busyActionRef: MutableRefObject<string | null>
  setActionError: (message: string | null) => void
}

function pushReviewRoute(
  router: ReturnType<typeof useRouteHandoff>,
  target: MobileReviewRouteTarget
): void {
  triggerSelection()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder emits the app's registered /h/[hostId]/review/[worktreeId] route as a string href.
  router.push(buildMobileReviewFileRoute(target) as Parameters<typeof router.push>[0])
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
  const router = useRouteHandoff()
  const [branchDiffPreview, setBranchDiffPreview] = useState<MobileBranchDiffPreviewState | null>(
    null
  )
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const [openingBranchPath, setOpeningBranchPath] = useState<string | null>(null)
  const openingPathRef = useRef<string | null>(null)
  const openingBranchPathRef = useRef<string | null>(null)

  const openFile = useCallback(
    async (entry: MobileGitStatusEntry) => {
      // Deletions are openable (pre-delete text/image via git.diff); only block
      // unresolved conflicts, matching canOpenMobileGitStatusEntry / row UI.
      // An entry with no area is in no section, so no row can reach this anyway.
      const area = entry.area
      if (!canOpenMobileGitStatusEntry(entry) || area === undefined) {
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
        const openReviewRoute = (): void =>
          pushReviewRoute(router, {
            hostId,
            worktreeId,
            worktreeName: name,
            filePath: entry.path,
            area
          })
        if (origin !== 'session') {
          openReviewRoute()
          return
        }
        // Snapshot the active tab now, at tap time, before the openDiff RPC —
        // the session uses it to avoid stealing focus if the user switches tabs
        // during the RPC window.
        const canRevealFile = onFileOpenStart?.()
        const openedTabMode = await openSessionChangedFile(client, {
          worktreeId,
          relativePath: entry.path,
          staged: area === 'staged'
        })
        if (!mountedRef.current) {
          return
        }
        if (openedTabMode === 'device-review') {
          if (canRevealFile && !canRevealFile()) {
            return
          }
          openReviewRoute()
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
      hostId,
      mountedRef,
      name,
      onFileOpenStart,
      onOpenedFileDiff,
      onRequestClose,
      origin,
      router,
      setActionError,
      worktreeId
    ]
  )

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

      openingBranchPathRef.current = entry.path
      setOpeningBranchPath(entry.path)
      if (origin !== 'session') {
        pushReviewRoute(router, {
          hostId,
          worktreeId,
          worktreeName: name,
          filePath: entry.path,
          area: 'branch'
        })
        openingBranchPathRef.current = null
        if (mountedRef.current) {
          setOpeningBranchPath(null)
        }
        return
      }
      setBranchDiffPreview({ kind: 'loading', entry })
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
        if (!mountedRef.current) {
          return
        }
        setBranchDiffPreview({
          kind: 'ready',
          entry,
          summary,
          lines: highlightMobileDiffLines(diff.lines, syntaxLanguage),
          truncated: diff.truncated
        })
        triggerSelection()
      } catch (err) {
        if (!mountedRef.current) {
          return
        }
        triggerError()
        setBranchDiffPreview({
          kind: 'error',
          entry,
          message: err instanceof Error ? err.message : 'Unable to load committed diff'
        })
      } finally {
        if (openingBranchPathRef.current === entry.path) {
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
      hostId,
      mountedRef,
      name,
      origin,
      router,
      setActionError,
      worktreeId
    ]
  )

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
