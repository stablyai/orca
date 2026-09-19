import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileAccessoryKeyBar } from './MobileAccessoryKeyBar'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios', select: (values: { ios?: unknown }) => values.ios }
}))

describe('MobileAccessoryKeyBar', () => {
  it('keeps local controls enabled when remote input is disabled and dismissal outside scrolling', () => {
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        createElement(MobileAccessoryKeyBar, {
          disabled: true,
          leading: createElement('DismissKeyboard'),
          keys: [
            { id: 'remote', label: 'Tab' },
            { id: 'compose', label: 'Buffered input', disabled: false, active: true },
            { id: 'add', label: '+', disabled: false }
          ]
        })
      )
    })
    if (!renderer) {
      throw new Error('Accessory bar did not render')
    }
    const keys = renderer.root.findAllByType('Pressable')
    expect(keys.map((key) => key.props.disabled)).toEqual([true, false, false])
    expect(keys[1]?.props.accessibilityState).toEqual({ disabled: false, selected: true })
    const scroll = renderer.root.findByType('ScrollView')
    expect(scroll.props.keyboardShouldPersistTaps).toBe('always')
    expect(scroll.findAllByType('DismissKeyboard')).toHaveLength(0)
    expect(renderer.root.findAllByType('DismissKeyboard')).toHaveLength(1)
    const mounted = renderer
    act(() => mounted.unmount())
  })
})
