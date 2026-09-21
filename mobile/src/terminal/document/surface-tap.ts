import { notify } from './host-notify'
import {
  buildMouseClickInput,
  getMouseTrackingMode,
  isClickMouseTrackingMode
} from './mouse-input-encoding'
import { oscLinkAtViewportPoint, resolveTerminalFileUrlTap } from './osc-link-tap'
import { filePathAtViewportPoint } from './path-tap'
import { fileUrlAtViewportPoint, urlAtViewportPoint } from './url-tap'

export function notifyTerminalSurfaceTap(originX: number, originY: number, focusKeyboard: boolean) {
  const tappedOscLink = oscLinkAtViewportPoint(originX, originY)
  if (tappedOscLink && tappedOscLink.kind === 'file') {
    notify({
      type: 'terminal-file-tap',
      pathText: tappedOscLink.fileTap.pathText,
      line: tappedOscLink.fileTap.line,
      column: tappedOscLink.fileTap.column
    })
    return
  }
  const tappedFileUrl = fileUrlAtViewportPoint(originX, originY)
  const tappedFileUrlPath = tappedFileUrl ? resolveTerminalFileUrlTap(tappedFileUrl) : null
  if (tappedFileUrlPath) {
    notify({
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
      : urlAtViewportPoint(originX, originY)
  if (tappedUrl) {
    notify({ type: 'open-url', url: tappedUrl })
    return
  }
  const tappedPath = filePathAtViewportPoint(originX, originY)
  if (tappedPath) {
    notify({
      type: 'terminal-file-tap',
      pathText: tappedPath.pathText,
      line: tappedPath.line,
      column: tappedPath.column
    })
    return
  }
  const clickInput = buildMouseClickInput(originX, originY)
  if (clickInput) {
    notify({ type: 'terminal-input', bytes: clickInput })
  }
  // Touch still needs native input focus after the TUI consumes its mouse click.
  if (focusKeyboard || !isClickMouseTrackingMode(getMouseTrackingMode())) {
    notify({ type: 'terminal-tap' })
  }
}
