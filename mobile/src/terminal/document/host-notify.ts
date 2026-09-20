import { scope } from './document-scope'

// Declared beside the seam that hands it out, and re-exported here because this is where the
// document's readers have always named it.
export type { TerminalEngineError } from './document-host-seams'
import type { TerminalEngineError } from './document-host-seams'

/**
 * The postMessage bridge to the host, and the engine error reporting that rides on it.
 *
 * They are one module because the document declares them together, ahead of the message router
 * that both serve.
 */

declare global {
  interface Window {
    __engineErrors: string[]
  }
}

export function notify(msg: Record<string, unknown>) {
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

export function reportEngineError(context: string, err: TerminalEngineError, fatal?: unknown) {
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
  if (window.__engineErrors && window.__engineErrors.length) {
    parts.push('captured: ' + window.__engineErrors.join(' | '))
  }
  parts.push(chromeVersionText())
  notify({
    type: 'error',
    fatal: isFatal,
    message: parts.join(' - ')
  })
}

export function startHostNotify() {
  scope.uninstallErrorReporter = scope.installErrorReporter(function (
    msg: string | (Event & { message?: unknown }),
    source,
    line,
    column,
    err?: TerminalEngineError
  ) {
    if (window.__engineErrors.length < 20) {
      window.__engineErrors.push(String(msg))
    }
    reportEngineError('terminal runtime error', err || msg)
  })
}

export function stopHostNotify() {
  if (scope.uninstallErrorReporter) {
    scope.uninstallErrorReporter()
    scope.uninstallErrorReporter = null
  }
}
