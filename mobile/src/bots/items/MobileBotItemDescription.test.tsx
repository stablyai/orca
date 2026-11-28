import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileBotItemDescription } from './MobileBotItemDescription'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios }
}))
vi.mock('../../session/native-chat/transcript/message-content/MobileNativeChatMarkdown', () => ({
  MobileNativeChatMarkdown: 'Markdown'
}))

let tree: ReactTestRenderer | null = null

afterEach(() => {
  const shown = tree
  if (shown) {
    act(() => shown.unmount())
  }
  tree = null
})

const isHost = (node: { type: unknown }, name: string): boolean => node.type === name

function styleOf(node: ReactTestInstance): Record<string, number> {
  return Object.assign({}, ...[node.props.style].flat())
}

// A description taller than its three 20pt lines, as onLayout reports it.
function clampedDescription(): ReactTestInstance {
  act(() => {
    tree = create(createElement(MobileBotItemDescription, { text: 'A long description.' }))
  })
  const measured = tree!.root.find((node) => isHost(node, 'View') && node.props.onLayout)
  act(() => measured.props.onLayout({ nativeEvent: { layout: { height: 120 } } }))
  return tree!.root.find((node) => isHost(node, 'Pressable'))
}

it('gives Show more a 44pt tap box without moving it', () => {
  const button = clampedDescription()
  const box = styleOf(button)
  const label = styleOf(button.find((node) => isHost(node, 'Text')))
  expect(label.lineHeight + 2 * box.paddingVertical).toBeGreaterThanOrEqual(44)
  expect(box.marginVertical).toBe(-box.paddingVertical)
})

it('shows no Show more when the description fits in three lines', () => {
  act(() => {
    tree = create(createElement(MobileBotItemDescription, { text: 'Short.' }))
  })
  const measured = tree!.root.find((node) => isHost(node, 'View') && node.props.onLayout)
  act(() => measured.props.onLayout({ nativeEvent: { layout: { height: 60 } } }))
  expect(tree!.root.findAll((node) => isHost(node, 'Pressable'))).toHaveLength(0)
})
