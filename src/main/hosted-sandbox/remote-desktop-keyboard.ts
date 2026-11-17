// Keyboard rules for a remote desktop page. While it has focus every key goes to the sandbox
// (Orca's shortcuts included), like a VM console, so Ctrl/Cmd combos type normally there. One
// chord gives the keyboard back to Orca: Control+Command on macOS, Ctrl+Alt elsewhere, pressed
// together and released with no other key in between (so Ctrl+Alt+T still reaches the sandbox).

export type RemoteDesktopKeyInput = Pick<
  Electron.Input,
  'type' | 'key' | 'code' | 'control' | 'alt' | 'meta' | 'shift' | 'isAutoRepeat'
>

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Meta', 'Shift', 'AltGraph', 'OS'])

/** Feeds every key event; returns true on the event that completes the release chord. */
export function createReleaseChordTracker(
  platform: NodeJS.Platform
): (input: RemoteDesktopKeyInput) => boolean {
  const mac = platform === 'darwin'
  const chordKeys = mac ? new Set(['Control', 'Meta']) : new Set(['Control', 'Alt'])
  let armed = false
  return (input) => {
    // Windows reports AltGr as Ctrl+Alt: a lone AltGr tap must not release the keyboard.
    if (!mac && input.code === 'AltRight') {
      armed = false
      return false
    }
    if (input.type === 'keyDown') {
      if (!MODIFIER_KEYS.has(input.key)) {
        armed = false
        return false
      }
      const held = mac
        ? input.control && input.meta && !input.alt && !input.shift
        : input.control && input.alt && !input.meta && !input.shift
      armed = held && chordKeys.has(input.key) ? true : armed && held
      return false
    }
    if (input.type === 'keyUp' && armed && chordKeys.has(input.key)) {
      armed = false
      return true
    }
    return false
  }
}

/**
 * How a paste key reaches the sandbox after its clipboard is set: Cmd+V on macOS becomes
 * Shift+Insert (Linux apps ignore Super+V), Ctrl+V / Ctrl+Shift+V / Shift+Insert are replayed.
 */
export type RemoteDesktopPasteChord =
  | { kind: 'mac' }
  | { kind: 'replay'; key: 'v' | 'V' | 'Insert' }

export function remoteDesktopPasteChord(
  input: RemoteDesktopKeyInput,
  platform: NodeJS.Platform
): RemoteDesktopPasteChord | null {
  if (input.type !== 'keyDown' || input.alt) {
    return null
  }
  // The letter the layout produces (Dvorak Ctrl+K sits on the physical V key); the physical key
  // only when the layout has no Latin letter there (Cyrillic, Greek).
  const latin = /^[a-z]$/i.test(input.key)
  const v = latin ? input.key === 'v' || input.key === 'V' : input.code === 'KeyV'
  if (platform === 'darwin' && input.meta && !input.control && v) {
    return { kind: 'mac' }
  }
  if (input.control && !input.meta && v) {
    return { kind: 'replay', key: input.shift ? 'V' : 'v' }
  }
  if (input.shift && !input.control && !input.meta && input.key === 'Insert') {
    return { kind: 'replay', key: 'Insert' }
  }
  return null
}
