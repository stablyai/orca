import type { TerminalDocumentScope } from './document-scope'
import { C1_CSI, ESC } from './escape-introducers'

/** Claude's record dot, which iOS WebKit would otherwise promote to a colourful emoji glyph. */
const CLAUDE_STATUS_DOT = '\u23fa'

/** The variation selector that forces the text glyph. */
const TEXT_PRESENTATION_SELECTOR = '\ufe0e'

/** The variation selector that forces the emoji glyph. */
const EMOJI_PRESENTATION_SELECTOR = '\ufe0f'

/**
 * The dot with any trailing selectors, as one pattern.
 *
 * A literal rather than a construction: a `new RegExp` at a module's top level is parse-time work
 * (ruling 20), and `replace` leaves no `lastIndex` behind for the next document to find.
 */
const CLAUDE_STATUS_DOT_PATTERN = /\u23fa[\ufe0e\ufe0f]*/g

/**
 * The most code units one `term.write` receives.
 *
 * Why: xterm parses each write as one job, so a large PTY burst or scrollback replay would hold the
 * WebView thread until all of it parsed. Slices keep order and let input and paint interleave.
 */
export const TERMINAL_WRITE_SLICE_UNITS = 4 * 1024

/** How far a split DECSET may be carried before the mode scan gives up. */
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

// Why: iOS WebKit promotes Claude's record/status dot to a colorful emoji glyph.
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
  const normalized = normalizeStatusDotPresentation(scope, data)
  // Why: a bridge frame can arrive without text; queue it as before, as the scans above tolerate it.
  if (typeof normalized !== 'string' || normalized.length <= TERMINAL_WRITE_SLICE_UNITS) {
    scope.writeQueue.push(normalized)
    return
  }
  let offset = 0
  while (offset < normalized.length) {
    let end = Math.min(normalized.length, offset + TERMINAL_WRITE_SLICE_UNITS)
    // Why: a slice ending on a high surrogate would hand xterm half of an astral character.
    const last = normalized.charCodeAt(end - 1)
    if (end < normalized.length && last >= 0xd800 && last <= 0xdbff) {
      end--
    }
    scope.writeQueue.push(normalized.slice(offset, end))
    offset = end
  }
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
  // Why: high-throughput terminals can enqueue faster than xterm parses;
  // compact consumed slots so drain work stays O(1) without retaining old chunks.
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
  // Why: PTY/SSH chunks can split a long combined DECSET before the final h/l.
  // Keep parser state far beyond normal mode lists while still bounding memory.
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
  // Why: xterm.write() parses asynchronously. Row adjustment/resizing must
  // wait until replayed SGR attributes have landed in the buffer.
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
