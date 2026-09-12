import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PickerListDrawer } from './PickerListDrawer'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    FlatList: (props: {
      data: unknown[]
      keyExtractor: (item: unknown, index: number) => string
      renderItem: (info: { item: unknown; index: number }) => unknown
    }) =>
      React.createElement(
        'FlatList',
        props,
        props.data.map((item, index) =>
          React.createElement(
            'FlatListItem',
            { key: props.keyExtractor(item, index) },
            props.renderItem({ item, index })
          )
        )
      ),
    Pressable: 'Pressable',
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({ Check: 'Check' }))

vi.mock('./BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children: ReactNode }) => children
}))

const items = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
  { id: 'gamma', label: 'Gamma' }
]

describe('PickerListDrawer rows', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('announces every row as a button and marks only the selected one', () => {
    act(() => {
      renderer = create(
        createElement(PickerListDrawer, {
          visible: true,
          title: 'Dark theme',
          items,
          selectedId: 'beta',
          onSelect: vi.fn(),
          onClose: vi.fn()
        })
      )
    })
    const rows = renderer!.root.findAllByType('Pressable')
    expect(rows).toHaveLength(items.length)
    for (const row of rows) {
      expect(row.props.accessibilityRole).toBe('button')
    }
    expect(rows.map((row) => row.props.accessibilityState.selected)).toEqual([false, true, false])
  })
})
