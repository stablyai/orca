import type { TerminalDocumentScope } from './document-scope'
import { C1_CSI, ESC } from './escape-introducers'

// Force Claude’s status dot to text presentation on iOS WebKit.
const CLAUDE_STATUS_DOT = '\u23fa'

const TEXT_PRESENTATION_SELECTOR = '\ufe0e'

const EMOJI_PRESENTATION_SELECTOR = '\ufe0f'

// Use a literal to keep module evaluation inert; replace does not retain lastIndex across document calls.
const CLAUDE_STATUS_DOT_PATTERN = /\u23fa[\ufe0e\ufe0f]*/g

const PRIVATE_MODE_SCAN_TAIL_LIMIT = 4096

export function resetWriteQueue(scope: TerminalDocumentScope) {
  scope.writeQueue = []
  scope.writeQueueHead = 0
}

export function isStatusDotPresentationSelector(value: string) {
  return value === TEXT_PRESENTATION_SELECTOR || value === EMOJI_PRESENTATION_SELECTOR
}

export function endsWithStatusDotPresentationSequence(data: string) {
  let i = data.length - 1
  while (i >= 0 && isStatusDotPresentationSelector(data.charAt(i))) {
    i--
  }
  return i >= 0 && data.charAt(i) === CLAUDE_STATUS_DOT
}

export function normalizeStatusDotPresentation(scope: TerminalDocumentScope, data: string) {
  if (typeof data !== 'string' || data.length === 0) {
    return data
  }
  if (scope.statusDotPendingSelector) {
    scope.statusDotPendingSelector = false
    let strippedPendingSelectors = false
    while (data.length > 0 && isStatusDotPresentationSelector(data.charAt(0))) {
      data = data.slice(1)
    }
    strippedPendingSelectors = data.length === 0
    if (strippedPendingSelectors) {
      scope.statusDotPendingSelector = true
      return ''
    }
  }
  const normalized = data.replace(
    CLAUDE_STATUS_DOT_PATTERN,
    CLAUDE_STATUS_DOT + TEXT_PRESENTATION_SELECTOR
  )
  scope.statusDotPendingSelector = endsWithStatusDotPresentationSequence(data)
  return normalized
}

export function enqueueWrite(scope: TerminalDocumentScope, data: string) {
  scope.writeQueue.push(normalizeStatusDotPresentation(scope, data))
}

export function enqueueWriteBoundary(scope: TerminalDocumentScope, callback: () => void) {
  scope.writeQueue.push(callback)
}

export function nextQueuedWrite(scope: TerminalDocumentScope) {
  if (scope.writeQueueHead >= scope.writeQueue.length) {
    resetWriteQueue(scope)
    return undefined
  }
  const next = scope.writeQueue[scope.writeQueueHead]
  scope.writeQueue[scope.writeQueueHead] = undefined
  scope.writeQueueHead++
  // Compact consumed slots to retain constant-time draining without holding parsed chunks.
  if (scope.writeQueueHead > 128 && scope.writeQueueHead * 2 > scope.writeQueue.length) {
    scope.writeQueue = scope.writeQueue.slice(scope.writeQueueHead)
    scope.writeQueueHead = 0
  }
  return next
}

export function disposeTermObservers(scope: TerminalDocumentScope) {
  const disposables = scope.termObserverDisposables
  scope.termObserverDisposables = []
  for (let i = 0; i < disposables.length; i++) {
    try {
      // oxlint-disable-next-line no-unused-expressions -- the guard is the call's own condition; the document's text is pinned token for token
      disposables[i] && disposables[i].dispose && disposables[i].dispose!()
    } catch {}
  }
}

export function extractMouseModeScanTail(input: string) {
  const start = Math.max(input.lastIndexOf(ESC), input.lastIndexOf(C1_CSI))
  if (start === -1) {
    return ''
  }
  const tail = input.slice(start)
  // Carry split combined DECSET state across PTY/SSH chunks, bounded beyond normal mode-list lengths.
  if (tail.length > PRIVATE_MODE_SCAN_TAIL_LIMIT) {
    return ''
  }
  if (tail === ESC || tail === ESC + '[' || tail === C1_CSI) {
    return tail
  }
  if (tail.indexOf(ESC + '[?') === 0) {
    return /^[0-9;]*$/.test(tail.slice(3)) ? tail : ''
  }
  if (tail.indexOf(C1_CSI + '?') === 0) {
    return /^[0-9;]*$/.test(tail.slice(2)) ? tail : ''
  }
  return ''
}

export function pumpWrites(scope: TerminalDocumentScope, gen: number): void {
  if (!scope.ready || !scope.term || scope.writesDraining || gen !== scope.terminalGeneration) {
    return
  }
  const next = nextQueuedWrite(scope)
  if (typeof next !== 'string') {
    if (typeof next === 'function') {
      return (next(), pumpWrites(scope, gen))
    }
    const callbacks = scope.afterDrainCallbacks
    scope.afterDrainCallbacks = []
    for (let i = 0; i < callbacks.length; i++) {
      callbacks[i]()
    }
    return
  }
  scope.writesDraining = true
  // xterm parses writes asynchronously; wait for replayed attributes before resizing rows.
  scope.term.write(next, function () {
    if (gen !== scope.terminalGeneration) {
      return
    }
    scope.writesDraining = false
    pumpWrites(scope, gen)
  })
}

export function afterWritesDrained(scope: TerminalDocumentScope, callback: () => void) {
  scope.afterDrainCallbacks.push(callback)
  pumpWrites(scope, scope.terminalGeneration)
}
