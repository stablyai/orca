import { isCommittedChatAttachmentCandidate } from '../../../../src/shared/native-chat-text-attachment-references'
import { createMobileFilePreviewHref } from '../preview/mobile-file-preview-route'
import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { ParsedFileLinkLocation } from '../../../../src/shared/file-links/file-link-location'
import { hostStackRouteHref } from '../../navigation/host-stack-navigation'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { useWorkspaceRouteHandoff } from '../../navigation/workspace-route-handoff'
import { triggerSelection } from '../../platform/haptics'
import { openMobileFileTap, type FileTapSessionTab } from './mobile-file-tap-open'
import { mobileSessionRouteTarget } from '../../session/mobile-session-route'
import { openMobileNativeChatFileTap } from '../../session/native-chat/visual/mobile-native-chat-open-file'
import { createClientAuthorityEpoch } from '../../transport/connection/client-authority-epoch'
import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'

type MobileFileTapHandlerOptions<T extends FileTapSessionTab> = {
  client: (UnvalidatedRpcRequestPort & { getGeneration?: () => number }) | null
  hostId: string
  worktreeId: string
  worktreeName?: string
  structuredAttachments?: boolean
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
  getSendCompletionGeneration: () => number
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
    getSendCompletionGeneration,
    hostId,
    nativeChatSessionId,
    structuredAttachments,
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
  const executionHost = useWorkspaceExecutionHost()
  const authorityRef = useRef(createClientAuthorityEpoch())
  const optionsRef = useRef(options)
  const activationSeqRef = useRef(0)

  useLayoutEffect(() => {
    routerRef.current = router
    authorityRef.current.update({ client, hostId, executionHost, worktreeId })
    optionsRef.current = {
      activeHandleRef,
      client,
      fetchSessionTabs,
      getActiveSessionTabId,
      getActiveSessionTabType,
      getSessionTabs,
      getSendCompletionGeneration,
      hostId,
      nativeChatSessionId,
      structuredAttachments,
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
    executionHost,
    fetchSessionTabs,
    getActiveSessionTabId,
    getActiveSessionTabType,
    getSessionTabs,
    getSendCompletionGeneration,
    hostId,
    nativeChatSessionId,
    structuredAttachments,
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
      const sourceNavigationGeneration = current.getSendCompletionGeneration()
      const sourceAuthority = authorityRef.current.token()
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
          sourceNavigationGeneration,
          activeNavigationGeneration: current.getSendCompletionGeneration(),
          sourceAuthorityCurrent: authorityRef.current.isCurrent(sourceAuthority),
          sourceTerminalHandle: handle,
          activeTerminalHandle: current.activeHandleRef.current,
          activeTabType: current.getActiveSessionTabType()
        }),
        switchSessionTab: current.switchSessionTab,
        scheduleDelayedAction: current.scheduleDelayedAction,
        onOpenFailed: ({ kind, message, pathText }) => {
          if (kind === 'failed') {
            current.reportChatTapFailure(message?.trim() || `Couldn't open ${pathText}`)
          }
        }
      })
    },
    []
  )

  const handleNativeChatFileTap = useCallback((pathText: string) => {
    const current = optionsRef.current
    if (current.structuredAttachments && isCommittedChatAttachmentCandidate(pathText)) {
      ++activationSeqRef.current
      routerRef.current.push(
        createMobileFilePreviewHref({
          hostId: current.hostId,
          worktreeId: current.worktreeId,
          source: 'chatAttachment',
          absolutePath: pathText
        })
      )
      return
    }
    const sourceTerminalHandle = current.activeHandleRef.current
    const nativeChatSessionId = current.nativeChatSessionId
    const nativeChatTabId = current.getActiveSessionTabId()
    if (!current.client || (!sourceTerminalHandle && !(nativeChatSessionId && nativeChatTabId))) {
      return
    }
    const activationSeq = ++activationSeqRef.current
    const sourceNavigationGeneration = current.getSendCompletionGeneration()
    const sourceAuthority = authorityRef.current.token()
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
      // Chat only: terminal output is full of bare directory paths, so a mis-tap there would jump workspaces.
      openWorkspace: (linkedWorktreeId) =>
        routerRef.current.push(
          hostStackRouteHref(
            mobileSessionRouteTarget({ hostId: current.hostId, worktreeId: linkedWorktreeId })
          )
        ),
      openBrowser: current.openBrowser,
      triggerOpenFeedback: triggerSelection,
      fetchSessionTabs: current.fetchSessionTabs,
      getSessionTabs: current.getSessionTabs,
      getActiveSessionTabId: current.getActiveSessionTabId,
      getActivationState: (activated) => ({
        activated,
        activationSeq,
        latestActivationSeq: activationSeqRef.current,
        sourceNavigationGeneration,
        activeNavigationGeneration: current.getSendCompletionGeneration(),
        sourceAuthorityCurrent: authorityRef.current.isCurrent(sourceAuthority),
        sourceTerminalHandle,
        activeTerminalHandle: current.activeHandleRef.current,
        sourceSessionTabId: nativeChatTabId,
        activeSessionTabId: current.getActiveSessionTabId(),
        activeTabType: current.getActiveSessionTabType()
      }),
      switchSessionTab: current.switchSessionTab,
      scheduleDelayedAction: current.scheduleDelayedAction,
      onOpenFailed: ({ message }) =>
        current.reportChatTapFailure(message?.trim() || `Couldn't open ${pathText}`)
    })
  }, [])

  return { handleFileTap, handleNativeChatFileTap }
}
