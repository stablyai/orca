import { adjustRowsForViewport, applyFitScale, clampPan } from './fit-scale'
import { repositionOverlay } from './selection-overlay'
import { handleMsg, type TerminalHostMessage } from './host-message-router'
import { notify, reportEngineError, type TerminalEngineError } from './host-notify'
import { updateTransform } from './viewport-transform'
import { scope } from './document-scope'

declare global {
  interface Window {
    Terminal?: unknown
  }
}

export function handleIncomingMessage(e: Event & { data?: TerminalHostMessage | string }) {
  let msg: TerminalHostMessage
  try {
    msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
  } catch {
    return
  }
  try {
    handleMsg(msg!)
  } catch (ex) {
    reportEngineError(
      msg && msg.type === 'init' ? 'terminal init failed' : 'terminal message failed',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a catch binding is `unknown`; the reporter reads only `message` and falls back to String().
      ex as TerminalEngineError,
      msg && msg.type === 'init' && !scope.everReady
    )
  }
}

export function startMessageBridge() {
  window.addEventListener('message', handleIncomingMessage)
  document.addEventListener('message', handleIncomingMessage)
  window.addEventListener('resize', function () {
    // Why: viewport changed (keyboard open/close, orientation, RN container
    // size update). Re-fit so the scale matches the new vpWidth — without
    // this, opening the keyboard leaves the terminal at the old scale even
    // though there's now less vertical room and the fit ratio may differ.
    applyFitScale('window-resize')
    adjustRowsForViewport()
    repositionOverlay()
    clampPan()
    updateTransform()
  })
  if (window.Terminal) {
    notify({ type: 'web-ready' })
  } else {
    reportEngineError('terminal engine missing', 'xterm failed to load', true)
  }
}
