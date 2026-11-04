import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { Pressable } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import { MobileNativeChatPromptCard } from './MobileNativeChatPromptCard'

vi.mock('react-native', async () => ({
  ...(await import('../../../test-support/react-native-motion-stub')).reactNativeMotionStub(),
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios }
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  CircleHelp: 'CircleHelp',
  ShieldQuestion: 'ShieldQuestion',
  X: 'X'
}))
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: 'Markdown' }))

describe('MobileNativeChatPromptCard permission disclosure', () => {
  it('keeps the same permission expanded while folded and closes a replacement request', async () => {
    let tree: ReactTestRenderer | null = null
    const render = (revision: number, collapsed: boolean) =>
      createElement(MobileNativeChatPromptCard, {
        permission: {
          title: 'Apply file changes?',
          detail: 'one\ntwo\nthree\nfour\nfive',
          prompt: { itemId: 'approval-1', expectedRevision: revision },
          options: []
        },
        collapsedPrompt: collapsed ? { title: 'Approval', expand: () => {} } : null
      })
    await act(async () => {
      tree = create(render(1, false))
    })
    const disclosure = () =>
      tree!.root
        .findAllByType(Pressable)
        .find((node) => typeof node.props.accessibilityState?.expanded === 'boolean')!
    expect(disclosure().props.accessibilityState.expanded).toBe(false)
    act(() => disclosure().props.onPress())
    await act(async () => tree!.update(render(1, true)))
    expect(disclosure().props.accessibilityState.expanded).toBe(true)
    await act(async () => tree!.update(render(2, false)))
    expect(disclosure().props.accessibilityState.expanded).toBe(false)
    act(() => tree!.unmount())
  })
})
