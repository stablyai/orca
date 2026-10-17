import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { applyMobileColorScheme } from '../theme/mobile-theme'
const clipboard = vi.hoisted(() => ({ writeText: vi.fn(async (_value: string) => {}) }))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => clipboard }))
vi.mock('lucide-react-native', () => ({ Copy: 'Copy', Check: 'Check' }))
vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (style: unknown) => style, hairlineWidth: 1 }
}))
import { MobileMarkdownCodeBlock } from './MobileMarkdownCodeBlock'
afterEach(() => {
  applyMobileColorScheme('dark')
  clipboard.writeText.mockReset()
})
it('renders line numbers separately and copies exactly the code without the gutter', async () => {
  const code = 'const value = "世界😀"\n\tvalue\n'
  let tree!: ReturnType<typeof create>
  act(() => {
    tree = create(
      createElement(MobileMarkdownCodeBlock, {
        code,
        language: 'ts',
        fontSize: 15,
        lineHeight: 21.25
      })
    )
  })
  try {
    const gutter = tree.root
      .findAll((node) => String(node.type) === 'Text')
      .find((node) => node.props.importantForAccessibility === 'no-hide-descendants')!
    expect(gutter.props.children).toBe('1\n2\n3')
    expect(gutter.props.selectable).toBe(false)
    const button = () => tree.root.find((node) => String(node.type) === 'Pressable')
    await act(async () => {
      await button().props.onPress()
    })
    expect(clipboard.writeText).toHaveBeenCalledWith(code)
    expect(button().props.accessibilityLabel).toBe('Code copied')
    const color = () =>
      tree.root
        .findAll((node) => String(node.type) === 'Text')
        .find((node) => node.props.children === 'const')?.props.style.color
    act(() => applyMobileColorScheme('light'))
    expect(color()).toBe('#cf222e')
    act(() => applyMobileColorScheme('dark'))
    expect(color()).toBe('#ff7b72')
  } finally {
    act(() => tree.unmount())
  }
})
