import type { TerminalDocumentScope } from './document-scope'
import type { TerminalEngineError } from './document-host-seams'

// Declared beside the seam that hands it out, and re-exported here because this is where the
// document's readers name it.
export type { TerminalEngineError } from './document-host-seams'

/**
 * The postMessage bridge to the host, and the engine error reporting that rides on it.
 *
 * They are one module because the document declares them together, ahead of the message router
 * that both serve.
 */

export function notify(scope: TerminalDocumentScope, msg: Record<string, unknown>) {
  scope.postToHost(msg)
}

export function engineErrorText(err: TerminalEngineError) {
  if (!err) {
    return ''
  }
  if (typeof err === 'string') {
    return err
  }
  if (err && typeof err.message === 'string') {
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
  err: TerminalEngineError,
  fatal?: unknown
) {
  const isFatal = fatal === undefined ? !scope.everReady : !!fatal
  if (!isFatal) {
    // Why: a constructed-but-degraded engine can throw per frame; cap
    // non-fatal notifies so RN isn't flooded. Fatal reports always emit.
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
    // Why: a degraded engine can throw per frame; cap so the buffer stays bounded for the
    // document's lifetime, which is the same cap the shell's pre-document handler holds itself to.
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
