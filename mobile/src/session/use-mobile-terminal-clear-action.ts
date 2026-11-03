import { translate } from '../i18n/mobile-i18n'
import { terminalBufferClear } from '../terminal/mobile-terminal-operations'
import type { Terminal } from './mobile-session-route-types'
import type { MobileSessionFileActionsModel } from './use-mobile-session-file-actions'

export function createMobileTerminalClearHandler(scope: MobileSessionFileActionsModel) {
  const {
    client,
    clientRef,
    clearSavedLiveInputSession,
    showToast,
    subscribeToTerminal,
    terminalUnsubsRef,
    unsubscribeTerminal
  } = scope

  return async function handleClearTerminal(target: Terminal) {
    if (!client) {
      return
    }
    // Why: only a different client is stale; the WebView handle is rebuilt on re-render and a path cutover keeps the same host.
    const isCurrent = () => clientRef.current === client
    try {
      const response = await terminalBufferClear.request(
        client,
        { terminal: target.handle },
        { failWhenDisconnected: true }
      )
      if (!isCurrent()) {
        return
      }
      if (terminalBufferClear.interpret(response) !== true) {
        showToast(
          translate('session.useTerminalInput.clearFailed', "Couldn't clear terminal"),
          1500
        )
        return
      }
      clearSavedLiveInputSession(target.handle)
      // Why: an unsubscribed tab draws a fresh snapshot when it next subscribes; subscribing it here would leak a background stream.
      if (terminalUnsubsRef.current.has(target.handle)) {
        unsubscribeTerminal(target.handle)
        subscribeToTerminal(target.handle)
      }
      showToast(translate('session.useTerminalInput.cleared', 'Terminal cleared'))
    } catch {
      if (isCurrent()) {
        showToast(
          translate('session.useTerminalInput.clearFailed', "Couldn't clear terminal"),
          1500
        )
      }
    }
  }
}
