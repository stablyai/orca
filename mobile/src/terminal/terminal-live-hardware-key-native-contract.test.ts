import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const androidSource = readFileSync(
  new URL(
    '../../packages/expo-hardware-keyboard/android/src/main/java/expo/modules/hardwarekeyboard/HardwareKeyboardCaptureView.kt',
    import.meta.url
  ),
  'utf8'
)
const iosSource = readFileSync(
  new URL(
    '../../packages/expo-hardware-keyboard/ios/HardwareKeyboardCaptureView.swift',
    import.meta.url
  ),
  'utf8'
)

// Match each guard with its own body to prevent unrelated pass-throughs from satisfying it.
function collapse(source: string): string {
  return source.replace(/\s+/g, ' ')
}

const android = collapse(androidSource)
const ios = collapse(iosSource)

const ANDROID_PASS_THROUGH = 'return super.dispatchKeyEvent(event) }'

describe('terminal live hardware key native contract', () => {
  it('leaves Android Meta shortcuts to the system', () => {
    expect(android).toContain(`if (hasMeta) { ${ANDROID_PASS_THROUGH}`)
  })

  it('leaves Android Enter on the TextInput submit path', () => {
    expect(android).toContain(
      'if ( event.keyCode == KeyEvent.KEYCODE_ENTER || ' +
        `event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER ) { ${ANDROID_PASS_THROUGH}`
    )
  })

  it('leaves every Android Ctrl+Space variant to the input-method switcher', () => {
    expect(android).toContain(
      `if (ctrl && event.keyCode == KeyEvent.KEYCODE_SPACE) { ${ANDROID_PASS_THROUGH}`
    )
    expect(androidSource).not.toContain('ctrl && !alt && event.keyCode')
  })

  it('leaves Android AltGr printable input to TextInput and the active layout', () => {
    expect(androidSource).toContain('KeyEvent.META_ALT_RIGHT_ON')
    expect(androidSource).toContain('ctrl && !isAlternateLayoutPrintable')
    expect(androidSource).toContain('event.getUnicodeChar(metaWithoutCtrl)')
  })

  it('compares Android Alt text with the same Shift/Caps state', () => {
    expect(android).toContain(
      'val metaWithoutCtrl = event.metaState and KeyEvent.META_CTRL_MASK.inv()'
    )
    expect(android).toContain(
      'if ((metaWithoutCtrl and KeyEvent.META_ALT_MASK) == 0) { return false }'
    )
    expect(android).toContain(
      'val metaWithoutCtrlOrAlt = metaWithoutCtrl and KeyEvent.META_ALT_MASK.inv()'
    )
    expect(android).toContain('val alternateCharacter = event.getUnicodeChar(metaWithoutCtrl)')
    expect(android).toContain('val baseCharacter = event.getUnicodeChar(metaWithoutCtrlOrAlt)')
  })

  it('keeps iOS Command input system-owned', () => {
    expect(ios).toContain('if sender.modifierFlags.contains(.command) { return }')
    // Command chords must remain absent from registration and handling.
    expect(ios).not.toContain('modifierSets: [UIKeyModifierFlags] = [ [.command]')
    expect(
      (ios.match(/for modifiers in modifierSets where !modifiers\.contains\(\.command\)/g) ?? [])
        .length
    ).toBeGreaterThanOrEqual(2)
    expect(ios).toContain('"meta": false')
  })

  it('uses official iOS function-key inputs and never registers Ctrl+Space', () => {
    expect(iosSource).toContain('UIKeyCommand.f1')
    expect(iosSource).toContain('UIKeyCommand.f12')
    expect(iosSource).not.toContain('UnicodeScalar(0xF704')
    expect(iosSource).not.toContain('UIKeyCommand(input: " ", modifierFlags: .control')
    // The handler must refuse Ctrl+Space even if UIKit supplies it.
    expect(ios).toContain('if sender.modifierFlags.contains(.control) && input == " " { return }')
  })

  it('keeps iOS Backspace and forward Delete distinct', () => {
    expect(ios).toContain('case UIKeyCommand.inputDelete: return "Backspace"')
    expect(ios).toContain('case "\\u{7f}": return "Delete"')
    expect(ios).not.toContain('case "\\u{8}", "\\u{7f}": return "Backspace"')
  })

  it('builds the iOS key-command list once instead of per keystroke', () => {
    expect(ios).toContain('private static let terminalKeyCommands: [UIKeyCommand]')
    expect(ios).toContain('return Self.terminalKeyCommands')
  })
})
