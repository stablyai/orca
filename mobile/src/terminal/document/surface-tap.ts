import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'
import {
  buildMouseClickInput,
  getMouseTrackingMode,
  isClickMouseTrackingMode
} from './mouse-input-encoding'
import { oscLinkAtViewportPoint } from './osc-link-tap'
import { viewportToCell } from './viewport-cell'
import type { ParsedFileLinkLocation } from '../../../../src/shared/file-links/file-link-location'
import {
  findTerminalFileLinksAtBufferPosition,
  findTerminalHttpLinkAtBufferPosition
} from '../../../../src/shared/terminal/links/terminal-link-buffer-hit-testing'

const QUAD_TAP_MAX_INTERVAL_MS = 400
const QUAD_TAP_MAX_DISTANCE_PX = 45

export function notifyTerminalSurfaceTap(
  scope: TerminalDocumentScope,
  originX: number,
  originY: number,
  focusKeyboard: boolean
) {
  const tappedOscLink = oscLinkAtViewportPoint(scope, originX, originY)
  if (tappedOscLink && tappedOscLink.kind === 'file') {
    scope.tapStreak = null
    notify(scope, { type: 'terminal-file-tap', candidates: [tappedOscLink.fileTap] })
    return
  }
  if (tappedOscLink && tappedOscLink.kind === 'url') {
    scope.tapStreak = null
    notify(scope, { type: 'open-url', url: tappedOscLink.url })
    return
  }
  const cell = viewportToCell(scope, originX, originY)
  const term = scope.term
  if (cell && term) {
    // Desktop's link detectors take 1-based cells and rebuild rows that wrap.
    const position = { x: cell.col + 1, y: cell.row + 1 }
    const buffer = term.buffer.active
    const url = findTerminalHttpLinkAtBufferPosition(buffer, position, term.cols)
    if (url) {
      scope.tapStreak = null
      notify(scope, { type: 'open-url', url })
      return
    }
    const { links, guesses } = findTerminalFileLinksAtBufferPosition(buffer, position, term.cols)
    // Why: a tap decides now, so only a path as written makes it a file tap; the host checks the guesses.
    if (links.length > 0) {
      scope.tapStreak = null
      const candidates = uniqueFileTapCandidates([...links, ...guesses])
      notify(scope, { type: 'terminal-file-tap', candidates })
      return
    }
  }
  if (focusKeyboard && scope.quadTapAltMEnabled) {
    const now = Date.now()
    const prev = scope.tapStreak
    const dx = prev ? originX - prev.x : 0
    const dy = prev ? originY - prev.y : 0
    const withinStreak =
      prev !== null &&
      now - prev.t <= QUAD_TAP_MAX_INTERVAL_MS &&
      dx * dx + dy * dy <= QUAD_TAP_MAX_DISTANCE_PX * QUAD_TAP_MAX_DISTANCE_PX
    const nextCount = withinStreak ? prev.count + 1 : 1
    if (nextCount >= 4) {
      scope.tapStreak = null
      notify(scope, { type: 'haptic', kind: 'selection' })
      notify(scope, { type: 'terminal-quad-tap' })
      return
    }
    scope.tapStreak = { count: nextCount, t: now, x: originX, y: originY }
  } else {
    scope.tapStreak = null
  }
  const clickInput = buildMouseClickInput(scope, originX, originY)
  if (clickInput) {
    // Flush pending live text before a click can move the TUI cursor.
    notify(scope, { type: 'terminal-input', bytes: clickInput, click: true })
  }
  // Touch still needs native focus after TUI clicks; unproven mouse encoding falls back to a plain tap.
  if (
    focusKeyboard ||
    !isClickMouseTrackingMode(getMouseTrackingMode(scope)) ||
    !scope.mouseEncodingKnown
  ) {
    notify(scope, { type: 'terminal-tap' })
  }
}

// One reading per path, the first, as desktop's existence probes keep.
function uniqueFileTapCandidates(links: readonly ParsedFileLinkLocation[]) {
  const seen = new Set<string>()
  const candidates: ParsedFileLinkLocation[] = []
  for (const { pathText, line, column } of links) {
    if (!seen.has(pathText)) {
      seen.add(pathText)
      candidates.push({ pathText, line, column })
    }
  }
  return candidates
}
