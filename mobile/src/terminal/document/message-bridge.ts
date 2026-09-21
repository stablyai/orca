import { handleMsg, type TerminalHostMessage } from './host-message-router'
import { notify, reportEngineError, type TerminalEngineError } from './host-notify'
import { scope } from './document-scope'
import type { TerminalDocumentHostFrame } from './document-host-seams'

/**
 * One frame from the host, routed.
 *
 * The parse is here rather than in the transport because the shape it parses into is the router's:
 * a bridge hands over JSON text and a host that holds `send` hands over the object, and either way
 * the document reads the same message.
 */
export function handleIncomingMessage(frame: TerminalDocumentHostFrame) {
  let msg: TerminalHostMessage
  try {
    msg = typeof frame === 'string' ? JSON.parse(frame) : frame
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

/**
 * The document's answer to its host: whatever transport the host has, and readiness.
 *
 * Both are seams because the two hosts differ on both (ruling 24). The WebView is sent frames as
 * `message` events and loads its engine from a script tag that can fail; the page calls `send`
 * directly and imported the engine before it built this document.
 */
export function startMessageBridge() {
  scope.uninstallHostTransport = scope.installHostTransport(handleIncomingMessage)
  if (scope.hasEngine()) {
    notify({ type: 'web-ready' })
  } else {
    reportEngineError('terminal engine missing', 'xterm failed to load', true)
  }
}

export function stopMessageBridge() {
  if (scope.uninstallHostTransport) {
    scope.uninstallHostTransport()
    scope.uninstallHostTransport = null
  }
}
