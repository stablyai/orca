import { notify } from './host-notify'
import { getMouseTrackingMode } from './mouse-input-encoding'
import type { TerminalDocumentModes, TerminalDocumentScope } from './document-scope'

export function emitModesIfChanged(scope: TerminalDocumentScope) {
  if (!scope.term) {
    return
  }
  const termModes = scope.term.modes
  let alt = false
  try {
    alt =
      scope.term.buffer && scope.term.buffer.active && scope.term.buffer.active.type === 'alternate'
  } catch {}
  const modes: TerminalDocumentModes = {
    bracketedPasteMode: !!termModes?.bracketedPasteMode,
    altScreen: alt,
    mouseTrackingMode: getMouseTrackingMode(scope),
    sgrMouseMode: scope.sgrMouseMode,
    sgrMousePixelsMode: scope.sgrMousePixelsMode,
    applicationCursorKeysMode: !!termModes?.applicationCursorKeysMode,
    kittyKeyboardFlags: scope.keyboardModes.flags,
    modifyOtherKeys: scope.keyboardModes.modifyOtherKeys
  }
  const last = scope.lastEmittedModes
  if (
    modes.bracketedPasteMode !== last.bracketedPasteMode ||
    modes.altScreen !== last.altScreen ||
    modes.mouseTrackingMode !== last.mouseTrackingMode ||
    modes.sgrMouseMode !== last.sgrMouseMode ||
    modes.sgrMousePixelsMode !== last.sgrMousePixelsMode ||
    modes.applicationCursorKeysMode !== last.applicationCursorKeysMode ||
    modes.kittyKeyboardFlags !== last.kittyKeyboardFlags ||
    modes.modifyOtherKeys !== last.modifyOtherKeys
  ) {
    scope.lastEmittedModes = modes
    notify(scope, { type: 'modes', ...modes })
  }
}
