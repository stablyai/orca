import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'
import {
  buildMouseClickInput,
  getMouseTrackingMode,
  isClickMouseTrackingMode
} from './mouse-input-encoding'
import { oscLinkAtViewportPoint } from './osc-link-tap'
import { viewportToCell } from './viewport-cell'
import type { ParsedFileLinkLocation } from '../../../../src/shared/file-link-location'
import {
  findTerminalFileLinksAtBufferPosition,
  findTerminalHttpLinkAtBufferPosition
} from '../../../../src/shared/terminal-link-buffer-hit-testing'

export function notifyTerminalSurfaceTap(
  scope: TerminalDocumentScope,
  originX: number,
  originY: number,
  focusKeyboard: boolean
) {
  const tappedOscLink = oscLinkAtViewportPoint(scope, originX, originY)
  if (tappedOscLink && tappedOscLink.kind === 'file') {
    notify(scope, { type: 'terminal-file-tap', candidates: [tappedOscLink.fileTap] })
    return
  }
  if (tappedOscLink && tappedOscLink.kind === 'url') {
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
      notify(scope, { type: 'open-url', url })
      return
    }
    const candidates = uniqueFileTapCandidates(
      findTerminalFileLinksAtBufferPosition(buffer, position, term.cols)
    )
    if (candidates.length > 0) {
      notify(scope, { type: 'terminal-file-tap', candidates })
      return
    }
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
