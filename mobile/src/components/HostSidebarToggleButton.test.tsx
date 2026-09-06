import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostSidebarToggleButton } from './HostSidebarToggleButton'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
vi.mock('lucide-react-native', () => ({
  PanelLeftClose: 'PanelLeftClose',
  PanelLeftOpen: 'PanelLeftOpen'
}))

describe('HostSidebarToggleButton', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function render(expanded: boolean, onPress = vi.fn()) {
    await act(async () => {
      renderer = create(createElement(HostSidebarToggleButton, { expanded, onPress }))
    })
    return { button: renderer!.root.findByType('Pressable'), onPress }
  }

  it('exposes an accessible reveal action when the sidebar is hidden', async () => {
    const { button, onPress } = await render(false)

    expect(button.props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityLabel: 'Show workspace sidebar',
      accessibilityHint: 'Shows the workspace list',
      accessibilityState: { expanded: false },
      hitSlop: 8
    })
    expect(renderer!.root.findByType('PanelLeftOpen')).toBeDefined()

    button.props.onPress()
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('reuses the control for the expanded sidebar hide action', async () => {
    const { button } = await render(true)

    expect(button.props.accessibilityLabel).toBe('Hide workspace sidebar')
    expect(button.props.accessibilityState).toEqual({ expanded: true })
    expect(renderer!.root.findByType('PanelLeftClose')).toBeDefined()
  })
})
