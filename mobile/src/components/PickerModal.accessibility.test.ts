import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PickerModal } from './PickerModal'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ Check: 'Check' }))

vi.mock('./BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({ children }: { children?: ReactNode }) =>
      React.createElement('BottomDrawer', null, children)
  }
})

describe('PickerModal accessibility', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('announces option rows as actionable with their selection and disabled state', async () => {
    await act(async () => {
      renderer = create(
        createElement(PickerModal, {
          visible: true,
          title: 'Create Workspace On',
          options: [
            { value: 'desk', label: 'Desk' },
            { value: 'laptop', label: 'Laptop', disabled: true }
          ],
          selected: 'desk',
          onSelect: vi.fn(),
          onClose: vi.fn()
        })
      )
    })

    const rows = renderer!.root.findAllByType('Pressable')
    expect(rows.map((row) => row.props.accessible)).toEqual([true, true])
    expect(rows.map((row) => row.props.accessibilityRole)).toEqual(['button', 'button'])
    expect(rows.map((row) => row.props.accessibilityState)).toEqual([
      { disabled: false, selected: true },
      { disabled: true, selected: false }
    ])
  })
})
