import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: {
    create: (styles: unknown) => styles,
    hairlineWidth: 1
  },
  Platform: { OS: 'ios', select: (map: Record<string, unknown>) => map.ios ?? map.default }
}))

vi.mock('lucide-react-native', () => ({
  Eye: () => React.createElement('EyeIcon'),
  EyeOff: () => React.createElement('EyeOffIcon')
}))

vi.mock('../theme/use-mobile-color-scheme', () => ({
  useMobileColorScheme: () => 'dark'
}))

import {
  MobileTerminalPasswordMaskOverlay,
  MobileTerminalPasswordMaskToggle
} from './MobileTerminalPasswordMaskOverlay'

describe('MobileTerminalPasswordMaskOverlay', () => {
  it('masks typed characters with COMPOSER_TEXT_SIZE asterisks and renders a separate trailing toggle cleanly', () => {
    const onToggleMask = vi.fn()
    let tree!: TestRenderer.ReactTestRenderer
    act(() => {
      tree = TestRenderer.create(
        <>
          <MobileTerminalPasswordMaskOverlay value="oiu" masked />
          <MobileTerminalPasswordMaskToggle masked onToggleMask={onToggleMask} />
        </>
      )
    })

    const texts = tree.root.findAllByType('Text' as never)
    expect(texts).toHaveLength(1)
    expect(texts[0]?.props.children).toBe('***')
    expect(texts[0]?.props.style?.fontSize).toBe(16)

    const button = tree.root.findByType('Pressable' as never)
    expect(button.props.accessibilityLabel).toBe('Show input')
    expect(button.props.accessibilityState).toEqual({ selected: true })
    act(() => {
      button.props.onPress()
    })
    expect(onToggleMask).toHaveBeenCalledTimes(1)
  })

  it('omits the asterisk overlay when masked=false while keeping the trailing toggle button accessible', () => {
    const onToggleMask = vi.fn()
    let tree!: TestRenderer.ReactTestRenderer
    act(() => {
      tree = TestRenderer.create(
        <>
          <MobileTerminalPasswordMaskOverlay value="oiu" masked={false} />
          <MobileTerminalPasswordMaskToggle masked={false} onToggleMask={onToggleMask} />
        </>
      )
    })

    expect(tree.root.findAllByType('Text' as never)).toHaveLength(0)
    const button = tree.root.findByType('Pressable' as never)
    expect(button.props.accessibilityLabel).toBe('Hide input')
    expect(button.props.accessibilityState).toEqual({ selected: false })
  })
})
