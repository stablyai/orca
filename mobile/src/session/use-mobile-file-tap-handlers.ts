import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { ParsedFileLinkLocation } from '../../../src/shared/file-link-location'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { triggerSelection } from '../platform/haptics'
import { openMobileFileTap, type FileTapSessionTab } from './mobile-file-tap-open'
import { openMobileNativeChatFileTap } from './native-chat/visual/mobile-native-chat-open-file'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

type MobileFileTapHandlerOptions<T extends FileTapSessionTab> = {
  client: RpcOperationSender | null
  hostId: string
  worktreeId: string
  worktreeName?: string
  nativeChatSessionId: string | null
  activeHandleRef: MutableRefObject<string | null>
  terminalCwdRef: MutableRefObject<Map<string, string>>
  openBrowser: (url: string) => void
  fetchSessionTabs: () => Promise<void>
  getSessionTabs: () => readonly T[]
  getActiveSessionTabId: () => string | null
  getActiveSessionTabType: () => string | null
  switchSessionTab: (tab: T) => void
  scheduleDelayedAction: (callback: () => void, delayMs: number) => unknown
  reportChatTapFailure: (message: string) => void
}

// Share stable dispatch-time handlers and activation sequence so newer terminal/chat file taps supersede in-flight opens.
export function useMobileFileTapHandlers<T extends FileTapSessionTab>(
  options: MobileFileTapHandlerOptions<T>
): {
  handleFileTap: (handle: string, candidates: readonly ParsedFileLinkLocation[]) => void
  handleNativeChatFileTap: (pathText: string) => void
} {
  const {
    activeHandleRef,
    client,
    fetchSessionTabs,
    getActiveSessionTabId,
    getActiveSessionTabType,
    getSessionTabs,
    hostId,
    nativeChatSessionId,
    openBrowser,
    scheduleDelayedAction,
    reportChatTapFailure,
    switchSessionTab,
    terminalCwdRef,
    worktreeId,
    worktreeName
  } = options
  const router = useWorkspaceRouteHandoff()
  const routerRef = useRef(router)
  const optionsRef = useRef(options)
  const activationSeqRef = useRef(0)

  useLayoutEffect(() => {
    routerRef.current = router
    optionsRef.current = {
      activeHandleRef,
      client,
      fetchSessionTabs,
      getActiveSessionTabId,
      getActiveSessionTabType,
      getSessionTabs,
      hostId,
      nativeChatSessionId,
      openBrowser,
      scheduleDelayedAction,
      reportChatTapFailure,
      switchSessionTab,
      terminalCwdRef,
      worktreeId,
      worktreeName
    }
  }, [
    activeHandleRef,
    client,
    fetchSessionTabs,
    getActiveSessionTabId,
    getActiveSessionTabType,
    getSessionTabs,
    hostId,
    nativeChatSessionId,
    openBrowser,
    router,
    scheduleDelayedAction,
    reportChatTapFailure,
    switchSessionTab,
    terminalCwdRef,
    worktreeId,
    worktreeName
  ])

  const handleFileTap = useCallback(
    (handle: string, candidates: readonly ParsedFileLinkLocation[]) => {
      const current = optionsRef.current
      if (
        handle !== current.activeHandleRef.current ||
        !current.client ||
        candidates.length === 0
      ) {
        return
      }
      const activationSeq = ++activationSeqRef.current
      openMobileFileTap<T>({
        client: current.client,
        hostId: current.hostId,
        worktreeId: current.worktreeId,
        worktreeName: current.worktreeName,
        terminalHandle: handle,
        cwd: current.terminalCwdRef.current.get(handle) ?? null,
        candidates,
        pushPreviewRoute: (href) => routerRef.current.push(href),
        openBrowser: current.openBrowser,
        triggerOpenFeedback: triggerSelection,
        fetchSessionTabs: current.fetchSessionTabs,
        getSessionTabs: current.getSessionTabs,
        getActiveSessionTabId: current.getActiveSessionTabId,
        getActivationState: (activated) => ({
          activated,
          activationSeq,
          latestActivationSeq: activationSeqRef.current,
          sourceTerminalHandle: handle,
          activeTerminalHandle: current.activeHandleRef.current,
          activeTabType: current.getActiveSessionTabType()
        }),
        switchSessionTab: current.switchSessionTab,
        scheduleDelayedAction: current.scheduleDelayedAction
      })
    },
    []
  )

  const handleNativeChatFileTap = useCallback((pathText: string) => {
    const current = optionsRef.current
    const sourceTerminalHandle = current.activeHandleRef.current
    const nativeChatSessionId = current.nativeChatSessionId
    const nativeChatTabId = current.getActiveSessionTabId()
    if (!current.client || (!sourceTerminalHandle && !(nativeChatSessionId && nativeChatTabId))) {
      return
    }
    const activationSeq = ++activationSeqRef.current
    openMobileNativeChatFileTap<T>({
      client: current.client,
      hostId: current.hostId,
      worktreeId: current.worktreeId,
      worktreeName: current.worktreeName,
      pathText,
      nativeChatContext:
        nativeChatSessionId && nativeChatTabId
          ? { tabId: nativeChatTabId, sessionId: nativeChatSessionId }
          : null,
      pushPreviewRoute: (href) => routerRef.current.push(href),
      openBrowser: current.openBrowser,
      triggerOpenFeedback: triggerSelection,
      fetchSessionTabs: current.fetchSessionTabs,
      getSessionTabs: current.getSessionTabs,
      getActiveSessionTabId: current.getActiveSessionTabId,
      getActivationState: (activated) => ({
        activated,
        activationSeq,
        latestActivationSeq: activationSeqRef.current,
        sourceTerminalHandle,
        activeTerminalHandle: current.activeHandleRef.current,
        sourceSessionTabId: nativeChatTabId,
        activeSessionTabId: current.getActiveSessionTabId(),
        activeTabType: current.getActiveSessionTabType()
      }),
      switchSessionTab: current.switchSessionTab,
      scheduleDelayedAction: current.scheduleDelayedAction,
      onOpenFailed: () => current.reportChatTapFailure(`Couldn't open ${pathText}`)
    })
  }, [])

  return { handleFileTap, handleNativeChatFileTap }
}
