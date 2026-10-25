import { enqueueWriteBoundary } from './write-queue'
import { notify } from './host-notify'
import type { TerminalDocumentDisposable, TerminalDocumentScope } from './document-scope'

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
  // Parser replies need stdin enabled; keep xterm’s textarea inert because native controls own keyboard input.
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
  // Live queries may queue behind replay; grant authority at the boundary so only fresh queries receive replies.
  enqueueTerminalDataReplyBoundary(scope, gen)
}
