import { handleMsg, type TerminalHostMessage } from './host-message-router'
import { notify, reportEngineError, type TerminalEngineError } from './host-notify'
import type { TerminalDocumentScope } from './document-scope'
import type { TerminalDocumentHostFrame } from './document-host-seams'

/**
 * One frame from the host, routed.
 *
 * The parse is here rather than in the transport because the shape it parses into is the router's:
 * a bridge hands over JSON text and a host that holds `send` hands over the object, and either way
 * the document reads the same message.
 */
export function handleIncomingMessage(
  scope: TerminalDocumentScope,
  frame: TerminalDocumentHostFrame
) {
  let msg: TerminalHostMessage
  try {
    msg = typeof frame === 'string' ? JSON.parse(frame) : frame
  } catch {
    return
  }
  try {
    handleMsg(scope, msg!)
  } catch (ex) {
    reportEngineError(
      scope,
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
export function startMessageBridge(scope: TerminalDocumentScope) {
  scope.uninstallHostTransport = scope.installHostTransport((frame) =>
    handleIncomingMessage(scope, frame)
  )
  if (scope.hasEngine()) {
    notify(scope, { type: 'web-ready' })
  } else {
    reportEngineError(scope, 'terminal engine missing', 'xterm failed to load', true)
  }
}

export function stopMessageBridge(scope: TerminalDocumentScope) {
  if (scope.uninstallHostTransport) {
    scope.uninstallHostTransport()
    scope.uninstallHostTransport = null
  }
}
