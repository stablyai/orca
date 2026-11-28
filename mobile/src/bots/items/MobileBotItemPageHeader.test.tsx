import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileBotItemPageHeader } from './MobileBotItemPageHeader'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios }
}))
vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronUp: 'ChevronUp',
  X: 'X'
}))

let tree: ReactTestRenderer | null = null

const isText = (node: { type: unknown }): boolean => node.type === 'Text'

afterEach(() => {
  const shown = tree
  if (shown) {
    act(() => shown.unmount())
  }
  tree = null
})

function heading(number: number | null): { text: unknown; label: unknown } {
  const stepper = { index: 1, total: 14, canStep: () => true, step: () => {} }
  act(() => {
    tree = create(
      createElement(MobileBotItemPageHeader, { number, stepper, online: true, onBack: () => {} })
    )
  })
  const title = tree!.root.find((node) => isText(node) && node.props.accessibilityRole === 'header')
  return { text: title.props.children, label: title.props.accessibilityLabel }
}

it('titles the bar with the item number and reads it as "Item 528"', () => {
  expect(heading(528)).toEqual({ text: '#528', label: 'Item 528' })
  expect(
    tree!.root.findAll((node) => isText(node) && node.props.children === '1 of 14')
  ).toHaveLength(1)
})

it('reads "Item" while the item has not loaded', () => {
  expect(heading(null)).toEqual({ text: 'Item', label: undefined })
})
