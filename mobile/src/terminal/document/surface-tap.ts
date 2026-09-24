import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'
import {
  buildMouseClickInput,
  getMouseTrackingMode,
  isClickMouseTrackingMode
} from './mouse-input-encoding'
import { oscLinkAtViewportPoint, resolveTerminalFileUrlTap } from './osc-link-tap'
import { filePathAtViewportPoint } from './path-tap'
import { fileUrlAtViewportPoint, urlAtViewportPoint } from './url-tap'

export function notifyTerminalSurfaceTap(
  scope: TerminalDocumentScope,
  originX: number,
  originY: number,
  focusKeyboard: boolean
) {
  const tappedOscLink = oscLinkAtViewportPoint(scope, originX, originY)
  if (tappedOscLink && tappedOscLink.kind === 'file') {
    notify(scope, {
      type: 'terminal-file-tap',
      pathText: tappedOscLink.fileTap.pathText,
      line: tappedOscLink.fileTap.line,
      column: tappedOscLink.fileTap.column
    })
    return
  }
  const tappedFileUrl = fileUrlAtViewportPoint(scope, originX, originY)
  const tappedFileUrlPath = tappedFileUrl ? resolveTerminalFileUrlTap(tappedFileUrl) : null
  if (tappedFileUrlPath) {
    notify(scope, {
      type: 'terminal-file-tap',
      pathText: tappedFileUrlPath.pathText,
      line: tappedFileUrlPath.line,
      column: tappedFileUrlPath.column
    })
    return
  }
  const tappedUrl =
    tappedOscLink && tappedOscLink.kind === 'url'
      ? tappedOscLink.url
      : urlAtViewportPoint(scope, originX, originY)
  if (tappedUrl) {
    notify(scope, { type: 'open-url', url: tappedUrl })
    return
  }
  const tappedPath = filePathAtViewportPoint(scope, originX, originY)
  if (tappedPath) {
    notify(scope, {
      type: 'terminal-file-tap',
      pathText: tappedPath.pathText,
      line: tappedPath.line,
      column: tappedPath.column
    })
    return
  }
  const clickInput = buildMouseClickInput(scope, originX, originY)
  if (clickInput) {
    notify(scope, { type: 'terminal-input', bytes: clickInput })
  }
  // Touch still needs native input focus after the TUI consumes its mouse click.
  if (focusKeyboard || !isClickMouseTrackingMode(getMouseTrackingMode(scope))) {
    notify(scope, { type: 'terminal-tap' })
  }
}
