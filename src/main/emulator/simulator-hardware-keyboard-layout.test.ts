import { describe, expect, it } from 'vitest'
import {
  iosHardwareLayoutForMacLayout,
  isUSHardwareKeyboard,
  parseAppleKeyboardsDefaults,
  withHardwareLayout,
  withOriginalHardwareLayouts
} from './simulator-hardware-keyboard-layout'

// Entries from the iOS 27.2 runtime's USBKeyboardLayouts.plist.
const IOS_LAYOUTS = {
  US: { KeyLayoutName: 'U.S.' },
  German: { KeyLayoutName: 'German' },
  'Swiss French': { KeyLayoutName: 'Swiss French' },
  'Turkish-QWERTY-PC': { KeyLayoutName: 'Turkish-QWERTY-PC' },
  '2SetHangul': { KeyLayoutName: '2SetHangul' }
}

describe('iosHardwareLayoutForMacLayout', () => {
  it('finds the iOS twin of an Apple Mac keyboard layout', () => {
    expect(iosHardwareLayoutForMacLayout('com.apple.keylayout.US', IOS_LAYOUTS)).toBe('U.S.')
    expect(iosHardwareLayoutForMacLayout('com.apple.keylayout.SwissFrench', IOS_LAYOUTS)).toBe(
      'Swiss French'
    )
    expect(
      iosHardwareLayoutForMacLayout('com.apple.keylayout.Turkish-QWERTY-PC', IOS_LAYOUTS)
    ).toBe('Turkish-QWERTY-PC')
  })

  it('has no twin for custom or IME-only Mac layouts', () => {
    expect(
      iosHardwareLayoutForMacLayout('org.sil.ukelele.keyboardlayout.custom', IOS_LAYOUTS)
    ).toBe(null)
    expect(iosHardwareLayoutForMacLayout('com.apple.keylayout.PinyinKeyboard', IOS_LAYOUTS)).toBe(
      null
    )
  })
})

describe('simulator AppleKeyboards', () => {
  it('rewrites only the hardware layout of each keyboard', () => {
    const entries = parseAppleKeyboardsDefaults(
      '(\n    "tr_TR@sw=Turkish-Q;hw=Automatic",\n    "emoji@sw=Emoji"\n)\n'
    )
    expect(withHardwareLayout(entries, 'German')).toEqual([
      'tr_TR@sw=Turkish-Q;hw=German',
      'emoji@sw=Emoji'
    ])
    expect(withHardwareLayout(null, 'German')).toEqual(['en_US@sw=QWERTY;hw=German'])
  })

  it('restores each keyboard layout and keeps keyboards the user added meanwhile', () => {
    expect(
      withOriginalHardwareLayouts(
        ['tr_TR@sw=Turkish-Q;hw=German', 'ja_JP-Romaji@sw=QWERTY-Japanese;hw=German'],
        ['tr_TR@sw=Turkish-Q;hw=Automatic']
      )
    ).toEqual(['tr_TR@sw=Turkish-Q;hw=Automatic', 'ja_JP-Romaji@sw=QWERTY-Japanese;hw=Automatic'])
    expect(withOriginalHardwareLayouts(['en_US@sw=QWERTY;hw=German'], null)).toBeNull()
  })

  it('treats only a US hardware layout as safe for US key usages', () => {
    expect(isUSHardwareKeyboard(null)).toBe(true)
    expect(isUSHardwareKeyboard(['en_US@sw=QWERTY;hw=Automatic', 'emoji@sw=Emoji'])).toBe(true)
    expect(isUSHardwareKeyboard(['en_US@sw=QWERTY;hw=U.S.'])).toBe(true)
    expect(isUSHardwareKeyboard(['tr_TR@sw=Turkish-Q;hw=Automatic'])).toBe(false)
    expect(isUSHardwareKeyboard(['en_US@sw=QWERTY;hw=German'])).toBe(false)
  })
})
