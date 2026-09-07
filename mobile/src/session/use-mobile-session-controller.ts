import { useMobileSessionFoundation } from './use-mobile-session-foundation'
import { useMobileSessionScreenState } from './use-mobile-session-screen-state'
import { useMobileSessionTerminalRuntime } from './use-mobile-session-terminal-runtime'
import { useMobileSessionFeedbackCapabilities } from './use-mobile-session-feedback-capabilities'
import { useMobileSessionNativeChatDictation } from './use-mobile-session-native-chat-dictation'
import { useMobileSessionTerminalSubscriptionFoundation } from './use-mobile-session-terminal-subscription-foundation'
import { useMobileSessionTerminalSubscription } from './use-mobile-session-terminal-subscription'
import { useMobileSessionTerminalStreamDisplay } from './use-mobile-session-terminal-stream-display'
import { useMobileSessionTerminalList } from './use-mobile-session-terminal-list'
import { useMobileSessionTabApplication } from './use-mobile-session-tab-application'
import { useMobileSessionDocumentReaders } from './use-mobile-session-document-readers'
import { useMobileSessionDiffComments } from './use-mobile-session-diff-comments'
import { useMobileSessionMarkdownActions } from './use-mobile-session-markdown-actions'
import { useMobileSessionTabReconciliation } from './use-mobile-session-tab-reconciliation'
import { useMobileSessionLifecycle } from './use-mobile-session-lifecycle'
import { useMobileSessionKeyboardState } from './use-mobile-session-keyboard-state'
import { useMobileSessionStartup } from './use-mobile-session-startup'
import { useMobileSessionPreferenceFocus } from './use-mobile-session-preference-focus'
import { useMobileSessionTabSwitching } from './use-mobile-session-tab-switching'
import { useMobileSessionTerminalWebview } from './use-mobile-session-terminal-webview'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'
import { useMobileSessionFileActions } from './use-mobile-session-file-actions'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'
import { useMobileSessionAccessorySelection } from './use-mobile-session-accessory-selection'
import { useMobileSessionAttachments } from './use-mobile-session-attachments'
import { useMobileSessionTerminalCreateActions } from './use-mobile-session-terminal-create-actions'
import { useMobileSessionContentCreateActions } from './use-mobile-session-content-create-actions'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
import { useMobileSessionBulkClose } from './use-mobile-session-bulk-close'
import { useMobileSessionPresentation } from './use-mobile-session-presentation'
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
  useMobileSessionPreferenceFocus(keyboardState)
  const tabSwitching = Object.assign(keyboardState, useMobileSessionTabSwitching(keyboardState))
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
  const attachments = Object.assign(
    accessorySelection,
    useMobileSessionAttachments(accessorySelection)
  )
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
  return panelRouteActions
}

export type MobileSessionController = ReturnType<typeof useMobileSessionController>
