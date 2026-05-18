import type {
  CanonicalChord,
  EffectiveKeymap,
  KeybindingActionId
} from '../../shared/keybindings/keybinding-types'

export function getElectronAccelerators(
  keymap: EffectiveKeymap,
  actionId: KeybindingActionId
): string[] {
  const binding = keymap.bindings.find((candidate) => candidate.id === actionId)
  return binding?.chords.map(chordToElectronAccelerator).filter((value) => value !== null) ?? []
}

function chordToElectronAccelerator(chord: CanonicalChord): string | null {
  const parts: string[] = []
  if (chord.cmd) {
    parts.push('Cmd')
  }
  if (chord.ctrl) {
    parts.push('Ctrl')
  }
  if (chord.alt) {
    parts.push('Alt')
  }
  if (chord.shift) {
    parts.push('Shift')
  }

  const key = chordKeyToElectronAcceleratorKey(chord.key)
  if (!key) {
    return null
  }
  parts.push(key)
  return parts.join('+')
}

function chordKeyToElectronAcceleratorKey(key: string): string | null {
  switch (key) {
    case 'arrowleft':
      return 'Left'
    case 'arrowright':
      return 'Right'
    case 'arrowup':
      return 'Up'
    case 'arrowdown':
      return 'Down'
    case 'escape':
      return 'Esc'
    case 'enter':
      return 'Enter'
    case 'backspace':
      return 'Backspace'
    case 'delete':
      return 'Delete'
    case 'insert':
      return 'Insert'
    case 'tab':
      return 'Tab'
    case 'pageup':
      return 'PageUp'
    case 'pagedown':
      return 'PageDown'
    case 'home':
      return 'Home'
    case 'end':
      return 'End'
    case 'space':
      return 'Space'
    case 'plus':
    case '+':
      return 'Plus'
    case '=':
      return '='
    case '-':
      return '-'
    case '_':
      return '_'
    case '[':
      return '['
    case ']':
      return ']'
    default:
      if (/^[a-z0-9]$/.test(key)) {
        return key.toUpperCase()
      }
      return key.length === 1 ? key.toUpperCase() : key
  }
}
