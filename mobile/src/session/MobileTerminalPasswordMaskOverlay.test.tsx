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

import { MobileTerminalPasswordMaskOverlay } from './MobileTerminalPasswordMaskOverlay'

describe('MobileTerminalPasswordMaskOverlay', () => {
  it('renders the show/hide toggle button and masks typed characters with asterisks when masked=true', () => {
    const onToggleMask = vi.fn()
    let tree!: TestRenderer.ReactTestRenderer
    act(() => {
      tree = TestRenderer.create(
        <MobileTerminalPasswordMaskOverlay value="oiu" masked onToggleMask={onToggleMask} />
      )
    })

    const texts = tree.root.findAllByType('Text' as never)
    expect(texts).toHaveLength(1)
    expect(texts[0]?.props.children).toBe('***')

    const button = tree.root.findByType('Pressable' as never)
    expect(button.props.accessibilityState).toEqual({ selected: true })
    act(() => {
      button.props.onPress()
    })
    expect(onToggleMask).toHaveBeenCalledTimes(1)
  })

  it('keeps the show/hide toggle button visible without rendering the asterisk overlay when masked=false', () => {
    const onToggleMask = vi.fn()
    let tree!: TestRenderer.ReactTestRenderer
    act(() => {
      tree = TestRenderer.create(
        <MobileTerminalPasswordMaskOverlay value="oiu" masked={false} onToggleMask={onToggleMask} />
      )
    })

    expect(tree.root.findAllByType('Text' as never)).toHaveLength(0)
    const button = tree.root.findByType('Pressable' as never)
    expect(button.props.accessibilityState).toEqual({ selected: false })
  })
})
