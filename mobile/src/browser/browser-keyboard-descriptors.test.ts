import { describe, expect, it, vi } from 'vitest'

import {
  buildBrowserKeyboardDescriptors,
  type BrowserPointerModifier
} from './browser-keyboard-descriptors'

function build(overrides: {
  selectedModifiers?: BrowserPointerModifier[]
  disabled?: boolean
  onToggleModifier?: (modifier: BrowserPointerModifier) => void
  onKeypress?: (key: string) => void
}) {
  return buildBrowserKeyboardDescriptors({
    selectedModifiers: overrides.selectedModifiers ?? [],
    disabled: overrides.disabled ?? false,
    onToggleModifier: overrides.onToggleModifier ?? (() => {}),
    onKeypress: overrides.onKeypress ?? (() => {})
  })
}

describe('buildBrowserKeyboardDescriptors', () => {
  it('returns modifiers then special keys in order', () => {
    const descriptors = build({})
    expect(descriptors.map((key) => key.id)).toEqual([
      'modifier-cmd',
      'modifier-ctrl',
      'modifier-alt',
      'modifier-shift',
      'key-Enter',
      'key-Backspace',
      'key-Tab',
      'key-Escape'
    ])
  })

  it('marks selected modifiers active and toggles on press', () => {
    const onToggleModifier = vi.fn()
    const descriptors = build({ selectedModifiers: ['cmd'], onToggleModifier })
    const cmd = descriptors.find((key) => key.id === 'modifier-cmd')
    const ctrl = descriptors.find((key) => key.id === 'modifier-ctrl')
    expect(cmd?.active).toBe(true)
    expect(ctrl?.active).toBe(false)
    cmd?.onPress?.()
    expect(onToggleModifier).toHaveBeenCalledWith('cmd')
  })

  it('renders special keys as momentary and sends the key on press', () => {
    const onKeypress = vi.fn()
    const descriptors = build({ onKeypress })
    const enter = descriptors.find((key) => key.id === 'key-Enter')
    expect(enter?.active).toBeUndefined()
    enter?.onPress?.()
    expect(onKeypress).toHaveBeenCalledWith('Enter')
  })

  it('substitutes glyph labels for Backspace and Escape', () => {
    const descriptors = build({})
    expect(descriptors.find((key) => key.id === 'key-Backspace')?.label).toBe('⌫')
    expect(descriptors.find((key) => key.id === 'key-Escape')?.label).toBe('Esc')
    expect(descriptors.find((key) => key.id === 'key-Enter')?.label).toBe('Enter')
  })

  it('propagates disabled to every descriptor', () => {
    const descriptors = build({ disabled: true })
    expect(descriptors.every((key) => key.disabled === true)).toBe(true)
  })
})
