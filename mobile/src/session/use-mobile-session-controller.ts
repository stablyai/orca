import { useLayoutEffect } from 'react'
import { useMobileStructuredSessionOpening } from './use-mobile-structured-session-opening'
import { useNotificationPaneNavigation } from './tabs/use-notification-pane-navigation'
import { useMobileSessionFoundation } from './use-mobile-session-foundation'
import { useMobileSessionScreenState } from './use-mobile-session-screen-state'
import { useMobileSessionTerminalRuntime } from '../terminal/session/use-mobile-session-terminal-runtime'
import { useMobileSessionFeedbackCapabilities } from './use-mobile-session-feedback-capabilities'
import { useMobileSessionNativeChatDictation } from './use-mobile-session-native-chat-dictation'
import { useMobileSessionTerminalSubscriptionFoundation } from '../terminal/session/streaming/use-mobile-session-terminal-subscription-foundation'
import { useMobileSessionTerminalSubscription } from '../terminal/session/streaming/use-mobile-session-terminal-subscription'
import { useMobileSessionTerminalStreamDisplay } from '../terminal/session/streaming/use-mobile-session-terminal-stream-display'
import { useMobileSessionTerminalList } from '../terminal/session/inventory/use-mobile-session-terminal-list'
import { useMobileSessionTabApplication } from './tabs/use-mobile-session-tab-application'
import { useMobileSessionDocumentReaders } from '../files/session-documents/use-mobile-session-document-readers'
import { useMobileSessionDiffComments } from '../source-control/review/review-notes/use-mobile-session-diff-comments'
import { useMobileSessionMarkdownActions } from '../files/session-documents/use-mobile-session-markdown-actions'
import { useMobileSessionTabReconciliation } from './tabs/use-mobile-session-tab-reconciliation'
import { useMobileSessionLifecycle } from './use-mobile-session-lifecycle'
import { useMobileSessionKeyboardState } from '../terminal/session/input-controls/use-mobile-session-keyboard-state'
import { useMobileSessionStartup } from './use-mobile-session-startup'
import { useMobileSessionPreferenceFocus } from './use-mobile-session-preference-focus'
import { useMobileSessionTabSwitching } from './tabs/use-mobile-session-tab-switching'
import { useMobileSessionTerminalWebview } from '../terminal/session/use-mobile-session-terminal-webview'
import { useMobileSessionTerminalSendActions } from '../terminal/session/input-controls/use-mobile-session-terminal-send-actions'
import { useMobileSessionFileActions } from '../files/session-documents/use-mobile-session-file-actions'
import { useMobileSessionTerminalInput } from '../terminal/session/input-controls/use-mobile-session-terminal-input'
import { useMobileSessionAccessorySelection } from '../terminal/session/accessory-keys/use-mobile-session-accessory-selection'
import { useTerminalDockKeys } from '../terminal/session/accessory-keys/use-terminal-dock-keys'
import { useMobileSessionAttachments } from '../files/attachments/use-mobile-session-attachments'
import { useMobileSessionTerminalCreateActions } from '../terminal/session/creation/use-mobile-session-terminal-create-actions'
import { useMobileSessionContentCreateActions } from './use-mobile-session-content-create-actions'
import { useMobileSessionCloseActions } from './tabs/use-mobile-session-close-actions'
import { useMobileSessionBulkClose } from './tabs/use-mobile-session-bulk-close'
import { useMobileSessionPresentation } from './use-mobile-session-presentation'
import { useMobileSessionStoredChatTab } from './use-mobile-session-stored-chat-tab'
import { useMobileSessionPanelRouteActions } from './use-mobile-session-panel-route-actions'

export function useMobileSessionController() {
  const foundation = useMobileSessionFoundation()
  const screenState = Object.assign(foundation, useMobileSessionScreenState(foundation))
  const terminalRuntime = Object.assign(screenState, useMobileSessionTerminalRuntime(screenState))
  const feedbackCapabilities = Object.assign(
    terminalRuntime,
    useMobileSessionFeedbackCapabilities(terminalRuntime)
  )
  const sendLiveTerminalInput = (handle: string, bytes: string) =>
    feedbackCapabilities.sendLiveTerminalInputRef.current(handle, bytes)
  const nativeChatDictation = Object.assign(
    feedbackCapabilities,
    useMobileSessionNativeChatDictation(feedbackCapabilities, sendLiveTerminalInput)
  )
  // Chat covers a split, so only its own terminal stays visible; this is the ref's one writer per commit.
  if (nativeChatDictation.showNativeChat) {
    nativeChatDictation.visibleTerminalHandles = nativeChatDictation.activeHandle
      ? [nativeChatDictation.activeHandle]
      : []
  }
  const { visibleTerminalHandles, visibleTerminalHandlesRef } = nativeChatDictation
  useLayoutEffect(() => {
    visibleTerminalHandlesRef.current = visibleTerminalHandles
  })
  const subscriptionFoundation = Object.assign(
    nativeChatDictation,
    useMobileSessionTerminalSubscriptionFoundation(nativeChatDictation)
  )
  const terminalSubscription = Object.assign(
    subscriptionFoundation,
    useMobileSessionTerminalSubscription(subscriptionFoundation)
  )
  const terminalStreamDisplay = Object.assign(
    terminalSubscription,
    useMobileSessionTerminalStreamDisplay(terminalSubscription)
  )
  const terminalList = Object.assign(
    terminalStreamDisplay,
    useMobileSessionTerminalList(terminalStreamDisplay)
  )
  const tabApplication = Object.assign(terminalList, useMobileSessionTabApplication(terminalList))
  const documentReaders = Object.assign(
    tabApplication,
    useMobileSessionDocumentReaders(tabApplication)
  )
  const diffCommentsModel = Object.assign(
    documentReaders,
    useMobileSessionDiffComments(documentReaders)
  )
  const markdownActions = Object.assign(
    diffCommentsModel,
    useMobileSessionMarkdownActions(diffCommentsModel)
  )
  const tabReconciliation = Object.assign(
    markdownActions,
    useMobileSessionTabReconciliation(markdownActions)
  )
  const lifecycle = Object.assign(tabReconciliation, useMobileSessionLifecycle(tabReconciliation))
  const keyboardState = Object.assign(lifecycle, useMobileSessionKeyboardState(lifecycle))
  useMobileSessionStartup(keyboardState)
  useMobileSessionStoredChatTab(keyboardState)
  const preferences = useMobileSessionPreferenceFocus(keyboardState)
  const tabSwitching = Object.assign(keyboardState, useMobileSessionTabSwitching(keyboardState))
  const openNativeSession = useMobileStructuredSessionOpening(tabSwitching)
  useNotificationPaneNavigation({ ...tabSwitching, openNativeSession })
  const terminalWebview = Object.assign(tabSwitching, useMobileSessionTerminalWebview(tabSwitching))
  const terminalSendActions = Object.assign(
    terminalWebview,
    useMobileSessionTerminalSendActions(terminalWebview)
  )
  const fileActions = Object.assign(
    terminalSendActions,
    useMobileSessionFileActions(terminalSendActions)
  )
  const terminalInput = Object.assign(fileActions, useMobileSessionTerminalInput(fileActions))
  const accessorySelection = Object.assign(
    terminalInput,
    useMobileSessionAccessorySelection(terminalInput)
  )
  // The key row and the input fields share held ctrl/alt/shift, and the Duo rail renders the row apart from the fields.
  const dockKeys = Object.assign(accessorySelection, {
    dockKeys: useTerminalDockKeys({
      activeHandle: accessorySelection.activeHandle,
      sendInput: accessorySelection.handleAccessoryKey
    })
  })
  const attachments = Object.assign(dockKeys, useMobileSessionAttachments(dockKeys))
  const terminalCreateActions = Object.assign(
    attachments,
    useMobileSessionTerminalCreateActions(attachments)
  )
  const contentCreateActions = Object.assign(
    terminalCreateActions,
    useMobileSessionContentCreateActions(terminalCreateActions)
  )
  const closeActions = Object.assign(
    contentCreateActions,
    useMobileSessionCloseActions(contentCreateActions)
  )
  const bulkClose = Object.assign(closeActions, useMobileSessionBulkClose(closeActions))
  const presentation = Object.assign(bulkClose, useMobileSessionPresentation(bulkClose))
  const panelRouteActions = Object.assign(
    presentation,
    useMobileSessionPanelRouteActions(presentation)
  )
  // The one owner of opening an existing chat, so a fork's source link follows its selection rules.
  return Object.assign(panelRouteActions, preferences, { openNativeSession })
}

export type MobileSessionController = ReturnType<typeof useMobileSessionController>
