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
