import { notify } from './host-notify'
import { getMouseTrackingMode } from './mouse-input-encoding'
import { scope } from './document-scope'

export function emitModesIfChanged() {
  if (!scope.term) {
    return
  }
  const bp = !!(scope.term.modes && scope.term.modes.bracketedPasteMode)
  let alt = false
  const mouseTrackingMode = getMouseTrackingMode()
  try {
    alt =
      scope.term.buffer && scope.term.buffer.active && scope.term.buffer.active.type === 'alternate'
  } catch {}
  if (
    bp !== scope.lastEmittedModes.bracketedPasteMode ||
    alt !== scope.lastEmittedModes.altScreen ||
    mouseTrackingMode !== scope.lastEmittedModes.mouseTrackingMode ||
    scope.sgrMouseMode !== scope.lastEmittedModes.sgrMouseMode ||
    scope.sgrMousePixelsMode !== scope.lastEmittedModes.sgrMousePixelsMode
  ) {
    scope.lastEmittedModes = {
      bracketedPasteMode: bp,
      altScreen: alt,
      mouseTrackingMode: mouseTrackingMode,
      sgrMouseMode: scope.sgrMouseMode,
      sgrMousePixelsMode: scope.sgrMousePixelsMode
    }
    notify({
      type: 'modes',
      bracketedPasteMode: bp,
      altScreen: alt,
      mouseTrackingMode: mouseTrackingMode,
      sgrMouseMode: scope.sgrMouseMode,
      sgrMousePixelsMode: scope.sgrMousePixelsMode
    })
  }
}
