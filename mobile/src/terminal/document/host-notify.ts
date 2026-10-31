import type { TerminalDocumentScope } from './document-scope'
import type { TerminalEngineError } from './document-host-seams'

export type { TerminalEngineError } from './document-host-seams'

export function notify(scope: TerminalDocumentScope, msg: Record<string, unknown>) {
  if (!scope.interactionActive && (msg.type === 'terminal-input' || msg.type === 'terminal-tap')) {
    return
  }
  scope.postToHost(msg)
}

export function engineErrorText(err: unknown) {
  if (!err) {
    return ''
  }
  if (typeof err === 'string') {
    return err
  }
  if (
    (typeof err === 'object' || typeof err === 'function') &&
    'message' in err &&
    typeof err.message === 'string'
  ) {
    return err.message
  }
  try {
    return String(err)
  } catch {
    return ''
  }
}

export function chromeVersionText() {
  const match = String(navigator.userAgent || '').match(/(?:Chrome|Chromium)\/([0-9.]+)/)
  return match ? 'Chrome ' + match[1] : 'Chrome version unknown'
}

export function reportEngineError(
  scope: TerminalDocumentScope,
  context: string,
  err: unknown,
  fatal?: unknown
) {
  const isFatal = fatal === undefined ? !scope.everReady : !!fatal
  if (!isFatal) {
    // Degraded engines can throw per frame; cap nonfatal reports while always delivering fatal errors.
    scope.nonFatalErrorNotifies++
    if (scope.nonFatalErrorNotifies > 5) {
      return
    }
  }
  const parts = [context]
  const errText = engineErrorText(err)
  if (errText) {
    parts.push(errText)
  }
  const captured = scope.capturedEngineErrors()
  if (captured.length) {
    parts.push('captured: ' + captured.join(' | '))
  }
  parts.push(chromeVersionText())
  notify(scope, {
    type: 'error',
    fatal: isFatal,
    message: parts.join(' - ')
  })
}

export function startHostNotify(scope: TerminalDocumentScope) {
  scope.uninstallErrorReporter = scope.installErrorReporter(function (
    msg: string | (Event & { message?: unknown }),
    source,
    line,
    column,
    err?: TerminalEngineError
  ) {
    const captured = scope.capturedEngineErrors()
    // Bound captured engine errors for the document lifetime, matching the shell’s pre-document cap.
    if (captured.length < 20) {
      captured.push(String(msg))
    }
    reportEngineError(scope, 'terminal runtime error', err || msg)
  })
}

export function stopHostNotify(scope: TerminalDocumentScope) {
  if (scope.uninstallErrorReporter) {
    scope.uninstallErrorReporter()
    scope.uninstallErrorReporter = null
  }
}
