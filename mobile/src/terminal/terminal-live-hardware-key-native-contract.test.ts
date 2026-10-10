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

function expectPassThroughBeforeCanonicalKey(guard: string): void {
  const guardStart = androidSource.indexOf(guard)
  const canonicalKeyStart = androidSource.indexOf('val key = canonicalKey(event)')
  expect(guardStart).toBeGreaterThanOrEqual(0)
  expect(canonicalKeyStart).toBeGreaterThan(guardStart)
  expect(androidSource.slice(guardStart, canonicalKeyStart)).toContain(
    'return super.dispatchKeyEvent(event)'
  )
}

describe('terminal live hardware key native contract', () => {
  // These source contracts guard wiring, not native IME event delivery.
  it('passes Android composing input through before mapping terminal keys', () => {
    expectPassThroughBeforeCanonicalKey('if (hasFocusedComposingText())')
    expect(androidSource).toContain('(findFocus() as? EditText)?.editableText')
    expect(androidSource).toContain('BaseInputConnection.getComposingSpanStart(editable) >= 0')
    expect(androidSource).toContain('BaseInputConnection.getComposingSpanEnd(editable) >= 0')
    expect(androidSource).not.toContain('requestFocus(')
    expect(androidSource).not.toContain('clearFocus(')
  })

  it('checks focused marked text before iOS command registration and dispatch', () => {
    const registrationStart = iosSource.indexOf('public override var keyCommands:')
    const dispatchStart = iosSource.indexOf('@objc func handleKeyCommand(')
    const registration = iosSource.slice(registrationStart, dispatchStart)
    const dispatch = iosSource.slice(dispatchStart, iosSource.indexOf('onHardwareKey(['))
    const guard = 'guard enabled, !hasFocusedMarkedText(in: self) else'
    expect(registration).toContain(guard)
    expect(registration).toContain('return nil')
    expect(dispatch).toContain(guard)
    expect(iosSource).toContain('view.isFirstResponder, let input = view as? UITextInput')
    expect(iosSource).toContain('input.markedTextRange != nil')
    expect(iosSource).toContain('view.subviews.contains { hasFocusedMarkedText(in: $0) }')
    expect(iosSource).not.toContain('becomeFirstResponder(')
    expect(iosSource).not.toContain('resignFirstResponder(')
  })

  it('leaves Android Enter on the TextInput submit path', () => {
    expectPassThroughBeforeCanonicalKey('event.keyCode == KeyEvent.KEYCODE_ENTER')
  })

  it('leaves every Android Ctrl+Space variant to the input-method switcher', () => {
    expectPassThroughBeforeCanonicalKey('if (ctrl && event.keyCode == KeyEvent.KEYCODE_SPACE)')
    expect(androidSource).not.toContain('ctrl && !alt && event.keyCode')
  })

  it('leaves Android AltGr printable input to TextInput and the active layout', () => {
    expect(androidSource).toContain('KeyEvent.META_ALT_RIGHT_ON')
    expect(androidSource).toContain('KeyEvent.META_CTRL_MASK.inv()')
    expect(androidSource).toContain('event.getUnicodeChar(metaWithoutCtrl)')
    expect(androidSource).toContain('ctrl && !isAlternateLayoutPrintable')
  })

  it('uses official iOS function-key inputs and never registers Ctrl+Space', () => {
    expect(iosSource).toContain('UIKeyCommand.f1')
    expect(iosSource).toContain('UIKeyCommand.f12')
    expect(iosSource).not.toContain('UnicodeScalar(0xF704')
    expect(iosSource).not.toContain('UIKeyCommand(input: " ", modifierFlags: .control')
  })
})
