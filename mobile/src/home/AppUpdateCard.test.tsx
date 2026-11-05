import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppUpdateCard } from './AppUpdateCard'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ ArrowUpFromLine: 'ArrowUpFromLine', X: 'X' }))

describe('AppUpdateCard', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render() {
    const onPress = vi.fn()
    const onDismiss = vi.fn()
    act(() => {
      renderer = create(createElement(AppUpdateCard, { version: '0.0.51', onPress, onDismiss }))
    })
    const root = renderer!.root
    return { root, onPress, onDismiss }
  }

  it('opens the update from the card body and dismisses from the X', () => {
    const { root, onPress, onDismiss } = render()
    const [body, dismiss] = root.findAll((node) => String(node.type) === 'Pressable')
    expect(dismiss.props.accessibilityLabel).toBe('Dismiss Orca 0.0.51 update')
    act(() => body.props.onPress())
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => dismiss.props.onPress())
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
