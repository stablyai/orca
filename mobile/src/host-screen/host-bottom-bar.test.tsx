import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Keyboard: { dismiss: () => {} },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {}, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Defs: 'Defs',
  LinearGradient: 'LinearGradient',
  Rect: 'Rect',
  Stop: 'Stop'
}))
vi.mock('lucide-react-native', () => ({ Plus: 'Plus', SlidersHorizontal: 'Sliders', X: 'X' }))
vi.mock('../platform/keyboard-occlusion', () => ({ useKeyboardOcclusion: () => 0 }))
vi.mock('../components/MobileSearchField', () => ({ MobileSearchField: 'MobileSearchField' }))

import { HostBottomBar } from './host-bottom-bar'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function render(fields: { connState: string; activeFilterCount: number }) {
  const state = {
    search: '',
    setSearch: vi.fn(),
    setShowWorkspaceOptions: vi.fn()
  }
  const actions = { openCreateMenu: vi.fn() }
  const controller = {
    actions,
    activeFilterCount: fields.activeFilterCount,
    connState: fields.connState,
    insets: { bottom: 34 },
    state
  }
  act(() => {
    renderer = create(
      createElement(HostBottomBar, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bar reads only these members.
        controller: controller as unknown as Parameters<typeof HostBottomBar>[0]['controller'],
        onCoveredHeightChange: () => {}
      })
    )
  })
  return { state, actions }
}

const button = (label: string): ReactTestInstance =>
  renderer!.root.find(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
  )

describe('the workspace list bottom bar', () => {
  it('opens Workspace options, counts active filters, and binds search to the list query', () => {
    const { state } = render({ connState: 'connected', activeFilterCount: 2 })
    const options = button('Workspace options (2 filters active)')
    expect(options.find((node) => String(node.type) === 'Text').props.children).toBe(2)
    act(() => options.props.onPress())
    expect(state.setShowWorkspaceOptions).toHaveBeenCalledWith(true)
    const field = renderer!.root.find((node) => String(node.type) === 'MobileSearchField')
    expect(field.props.placeholder).toBe('Search workspaces')
    act(() => field.props.onChangeText('fix'))
    expect(state.setSearch).toHaveBeenCalledWith('fix')
  })

  it('opens New workspace only while connected', () => {
    const { actions } = render({ connState: 'connected', activeFilterCount: 0 })
    act(() => button('New workspace').props.onPress())
    expect(actions.openCreateMenu).toHaveBeenCalledTimes(1)
    act(() => renderer?.unmount())
    render({ connState: 'reconnecting', activeFilterCount: 0 })
    expect(button('New workspace').props.disabled).toBe(true)
  })
})
