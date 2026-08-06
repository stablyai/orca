import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionSheetContent } from './ActionSheetModal'
import { PickerModal } from './PickerModal'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  Edit3: 'Edit3',
  Trash2: 'Trash2'
}))

vi.mock('./BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({ children }: { children?: unknown }) =>
      React.createElement('BottomDrawer', null, children)
  }
})

describe('bottom drawer action accessibility', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  async function render(element: ReturnType<typeof createElement>) {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(element)
    })
    consoleError.mockRestore()
  }

  it('announces action sheet rows as buttons with their current state', async () => {
    await render(
      createElement(ActionSheetContent, {
        actions: [
          {
            label: 'Reconnect',
            loading: true,
            onPress: vi.fn()
          }
        ]
      })
    )

    const action = renderer!.root.findByType('Pressable')
    expect(action.props.accessible).toBe(true)
    expect(action.props.accessibilityRole).toBe('button')
    expect(action.props.accessibilityState).toEqual({ disabled: true, busy: true })
  })

  it('announces picker rows as radio choices', async () => {
    await render(
      createElement(PickerModal, {
        visible: true,
        title: 'Choose Host',
        options: [
          { value: 'desk', label: 'Desk' },
          { value: 'laptop', label: 'Laptop', disabled: true }
        ],
        selected: 'desk',
        onSelect: vi.fn(),
        onClose: vi.fn()
      })
    )

    const choices = renderer!.root.findAllByType('Pressable')
    expect(choices[0].props.accessibilityRole).toBe('radio')
    expect(choices[0].props.accessibilityState).toEqual({ checked: true, disabled: false })
    expect(choices[1].props.accessibilityState).toEqual({ checked: false, disabled: true })
  })
})
