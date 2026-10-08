import { useLayoutEffect, useRef, useCallback } from 'react'
import { openExternalLink } from '../platform/external-link'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useMobileFileTapHandlers } from './use-mobile-file-tap-handlers'
import { resolveMobileNativeChatFileSessionId } from './mobile-native-chat-eligibility'
import { activateOpenedSourceControlDiffTab } from './opened-mobile-session-tab'
import { markdownImageTapPreviewHref } from './markdown-relative-image-srcs'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionTerminalSendActionsModel } from './use-mobile-session-terminal-send-actions'

export function useMobileSessionFileActions(scope: MobileSessionTerminalSendActionsModel) {
  const {
    hostId,
    worktreeId,
    routeWorktreeName,
    isFloatingWorkspaceRoute,
    client,
    sessionTabsRef,
    terminalLinkOpenMode,
    activeSessionTabIdRef,
    terminalCwdRef,
    activeHandleRef,
    activeSessionTab,
    activeSessionTabTypeRef,
    switchSessionTabRef,
    handleCreateBrowserRef,
    scheduleDelayedAction,
    nativeChatSendError,
    fetchSessionTabs
  } = scope
  // Tap a terminal or chat file path → resolve on host, open as file tab/preview.
  const { handleFileTap, handleNativeChatFileTap } = useMobileFileTapHandlers<MobileSessionTab>({
    client,
    hostId,
    worktreeId,
    worktreeName: routeWorktreeName,
    nativeChatSessionId: resolveMobileNativeChatFileSessionId(activeSessionTab),
    activeHandleRef,
    terminalCwdRef,
    openBrowser: (url) => void handleCreateBrowserRef.current?.(url),
    fetchSessionTabs,
    getSessionTabs: () => sessionTabsRef.current,
    getActiveSessionTabId: () => activeSessionTabIdRef.current,
    getActiveSessionTabType: () => activeSessionTabTypeRef.current,
    switchSessionTab: (tab) => switchSessionTabRef.current?.(tab),
    scheduleDelayedAction,
    reportChatTapFailure: nativeChatSendError.show
  })

  // A tapped markdown-editor image pushes its own zoomable preview route, resolved against the
  // active markdown tab's directory. The tab is read at tap time: per-keystroke doc updates must
  // not churn the callback identity the memoized editor receives.
  const router = useRouteHandoff()
  const activeSessionTabRef = useRef(activeSessionTab)
  useLayoutEffect(() => {
    activeSessionTabRef.current = activeSessionTab
  }, [activeSessionTab])
  const handleMarkdownImageTap = useCallback(
    (rawSrc: string) => {
      const tab = activeSessionTabRef.current
      if (!tab || tab.type !== 'markdown') {
        return
      }
      const href = markdownImageTapPreviewHref(rawSrc, tab.relativePath, {
        hostId,
        worktreeId,
        worktreeName: routeWorktreeName
      })
      if (href) {
        router.push(href)
      }
    },
    [hostId, routeWorktreeName, router, worktreeId]
  )

  const handleOpenedFileDiffActivationSeqRef = useRef(0)
  // Capture active tab at tap time; reading it after openDiff would misread a mid-RPC switch and let the retry steal focus.
  const fileOpenStartActiveTabIdRef = useRef<string | null>(null)
  const handleFileOpenStart = useCallback(() => {
    fileOpenStartActiveTabIdRef.current = activeSessionTabIdRef.current
  }, [])
  const handleOpenedFileDiff = useCallback(
    (relativePath: string) => {
      const activationSeq = ++handleOpenedFileDiffActivationSeqRef.current
      const activeTabIdAtTap = fileOpenStartActiveTabIdRef.current

      let activated = false
      const activateOpenedTab = async (): Promise<void> => {
        // Route matching through the shared helper so the repro test exercises the same logic production runs.
        const settled = await activateOpenedSourceControlDiffTab<MobileSessionTab>({
          relativePath,
          activeTabIdAtTap,
          fetchSessionTabs,
          getTabs: () => sessionTabsRef.current,
          getActiveTabId: () => activeSessionTabIdRef.current,
          getActivationState: () => ({
            activated,
            activationSeq,
            latestActivationSeq: handleOpenedFileDiffActivationSeqRef.current
          }),
          switchSessionTab: (tab) => switchSessionTabRef.current?.(tab)
        })
        if (settled) {
          activated = true
        }
      }

      scheduleDelayedAction(() => void activateOpenedTab(), 300)
      scheduleDelayedAction(() => void activateOpenedTab(), 900)
      scheduleDelayedAction(() => void activateOpenedTab(), 1800)
    },
    [fetchSessionTabs, scheduleDelayedAction]
  )

  const handleTerminalOpenUrl = useCallback(
    (handle: string, url: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      // Why: browser.tabCreate resolves a real worktree, which the floating
      // sentinel doesn't have — open taps in the phone browser instead.
      if (terminalLinkOpenMode === 'phone-browser' || isFloatingWorkspaceRoute) {
        openExternalLink(url)
        return
      }
      void handleCreateBrowserRef.current?.(url)
    },
    [terminalLinkOpenMode, isFloatingWorkspaceRoute]
  )
  return {
    handleFileTap,
    handleNativeChatFileTap,
    handleMarkdownImageTap,
    handleOpenedFileDiffActivationSeqRef,
    fileOpenStartActiveTabIdRef,
    handleFileOpenStart,
    handleOpenedFileDiff,
    handleTerminalOpenUrl
  }
}

export type MobileSessionFileActionsModel = MobileSessionTerminalSendActionsModel &
  ReturnType<typeof useMobileSessionFileActions>
