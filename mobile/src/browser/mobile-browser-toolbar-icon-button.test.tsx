import { createElement } from 'react'
import { Pressable } from 'react-native'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const longPress = vi.hoisted((): { go?: () => void } => ({}))

vi.mock('react-native', () => ({ Pressable: 'Pressable' }))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../theme/themed-styles', () => ({
  themedStyleSheet: () => ({
    button: { width: 26 },
    buttonPressed: { opacity: 0.7 },
    disabled: { opacity: 0.35 }
  })
}))
vi.mock('../navigation/session-list-long-press-props', () => ({
  useSessionListLongPressProps: () =>
    longPress.go ? { onLongPress: longPress.go, delayLongPress: 500 } : {}
}))

import { MobileBrowserToolbarIconButton } from './MobileBrowserToolbarIconButton'

function mount(disabled: boolean, toSessionList = true) {
  const onPress = vi.fn()
  let renderer = create(createElement('View'))
  act(() => {
    renderer.update(
      <MobileBrowserToolbarIconButton
        disabled={disabled}
        label="Back"
        onPress={onPress}
        toSessionList={toSessionList}
      >
        icon
      </MobileBrowserToolbarIconButton>
    )
  })
  return { onPress, button: renderer.root.findByType(Pressable) }
}

describe('MobileBrowserToolbarIconButton', () => {
  it('keeps the session-list hold when history cannot go back', () => {
    const go = vi.fn()
    longPress.go = go
    const { button, onPress } = mount(true)
    expect(button.props.disabled).toBe(false)
    expect(button.props.accessibilityRole).toBe('button')
    expect(button.props.onLongPress).toBe(go)
    expect(button.props.style({ pressed: false })).toContainEqual({ opacity: 0.35 })
    act(() => button.props.onPress({ nativeEvent: {} }))
    expect(go).not.toHaveBeenCalled()
    expect(onPress).not.toHaveBeenCalled()
    act(() => button.props.onPress({ key: 'Enter' }))
    act(() => button.props.onPress({ nativeEvent: { key: ' ' } }))
    expect(go).toHaveBeenCalledTimes(2)
    act(() => button.props.onLongPress())
    expect(go).toHaveBeenCalledTimes(3)
  })

  it('stays disabled when there is no session-list hold', () => {
    longPress.go = undefined
    const { button } = mount(true)
    expect(button.props.disabled).toBe(true)
    expect(button.props.onLongPress).toBeUndefined()
  })
})
