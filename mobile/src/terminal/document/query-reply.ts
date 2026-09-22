import { enqueueWriteBoundary } from './write-queue'
import { notify } from './host-notify'
import type { TerminalDocumentDisposable, TerminalDocumentScope } from './document-scope'

/**
 * The gate deciding when xterm's parser replies may reach the native host.
 *
 * One unit so the tests exercise the same replay and generation gate the document runs rather than
 * a re-implementation of it — which was already the reason this was one injected string.
 */
export type QueryReplyTerminal = {
  attachCustomKeyEventHandler: (handler: () => boolean) => void
  textarea?: {
    readOnly: boolean
    tabIndex: number
    setAttribute: (name: string, value: string) => void
  }
  onData: (listener: (data: string) => void) => TerminalDocumentDisposable
}

export function resetTerminalDataReplyAuthority(scope: TerminalDocumentScope) {
  scope.terminalDataRepliesEnabled = false
}

export function resumeTerminalDataReplyAuthority(scope: TerminalDocumentScope) {
  scope.terminalDataRepliesEnabled = true
}

export function forwardTerminalDataReply(scope: TerminalDocumentScope, data: string) {
  if (scope.terminalDataRepliesEnabled) {
    notify(scope, { type: 'terminal-data', bytes: data })
  }
}

export function enqueueTerminalDataReplyBoundary(scope: TerminalDocumentScope, gen: number) {
  enqueueWriteBoundary(scope, function () {
    if (gen === scope.terminalGeneration) {
      scope.terminalDataRepliesEnabled = true
    }
  })
}

export function attachTerminalQueryReplyBridge(
  scope: TerminalDocumentScope,
  term: QueryReplyTerminal,
  gen: number
) {
  // Why: parser replies require stdin enabled, but mobile input is owned by
  // native controls. Keep xterm's textarea inert for touch/hardware keys.
  try {
    term.attachCustomKeyEventHandler(function () {
      return false
    })
    if (term.textarea) {
      term.textarea.readOnly = true
      term.textarea.tabIndex = -1
      term.textarea.setAttribute('inputmode', 'none')
    }
  } catch {}
  try {
    scope.termObserverDisposables.push(
      term.onData(function (data) {
        forwardTerminalDataReply(scope, data)
      })
    )
  } catch {}
  // Why: live output can queue before initial replay finishes. Enable replies
  // at the replay boundary so those live queries are answered, never replayed ones.
  enqueueTerminalDataReplyBoundary(scope, gen)
}
