import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isMacAppPasteInput } from './mac-app-paste-input'

function cmdKey(key: string, code: string, extra: Partial<Electron.Input> = {}): Electron.Input {
  return {
    type: 'keyDown',
    key,
    code,
    isAutoRepeat: false,
    isComposing: false,
    meta: true,
    control: false,
    alt: false,
    shift: false,
    location: 0,
    modifiers: ['meta'],
    ...extra
  }
}

describe('isMacAppPasteInput', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['US Cmd+V', cmdKey('v', 'KeyV'), true],
    ['Caps Lock Cmd+V', cmdKey('V', 'KeyV'), true],
    ['Turkish F Cmd+V (V lives on KeyC)', cmdKey('v', 'KeyC'), true],
    ['Turkish F Cmd+C (C lives on KeyV)', cmdKey('c', 'KeyV'), false],
    ['Dvorak Cmd+V (V lives on Period)', cmdKey('v', 'Period'), true],
    ['Dvorak Cmd+K (K lives on KeyV)', cmdKey('k', 'KeyV'), false],
    ['BÉPO Cmd+. (. lives on KeyV)', cmdKey('.', 'KeyV'), false],
    ['Cyrillic Cmd+V (non-Latin key on KeyV)', cmdKey('м', 'KeyV'), true],
    ['Korean Cmd+V (Hangul jamo on KeyV)', cmdKey('ㅍ', 'KeyV'), true],
    ['Cmd+V during IME composition', cmdKey('Process', 'KeyV'), true],
    ['Cmd+Shift+V', cmdKey('V', 'KeyV', { shift: true }), false]
  ])('%s', (_name, input, expected) => {
    expect(isMacAppPasteInput(input)).toBe(expected)
  })

  it('never claims paste off macOS', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(isMacAppPasteInput(cmdKey('v', 'KeyV'))).toBe(false)
  })
})
