import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import {
  findAllByHostType,
  findByHostType
} from '../../../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  ShieldQuestion: 'ShieldQuestion',
  X: 'X'
}))
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))

describe('MobileNativeChatPermission operation details', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('previews an operation and expands in place while access and response tokens stay stable', async () => {
    const detail = 'update /repo/a.ts\nsecond\nthird\nfourth\n/outside/hidden.ts\n+full diff'
    const onRespond = vi.fn(async () => false)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatPermission, {
          permission: {
            title: 'Apply file changes?',
            description: 'Write access: /repo',
            decisionReason: 'Outside the sandbox',
            blockedPath: '/outside/hidden.ts',
            detail,
            options: [{ label: 'Allow', send: 'accept' }]
          },
          onRespond
        })
      )
    })
    const toggle = () => renderer!.root.findByProps({ accessibilityRole: 'button' })
    const shown = () => findAllByHostType(renderer!.root, 'Text').map((node) => node.props.children)
    const allow = () =>
      findByHostType(
        renderer!.root.findByProps({ testID: 'native-chat-approval-actions' }),
        'Pressable'
      )
    expect(toggle().props.accessibilityState.expanded).toBe(false)
    expect(shown()).toContain('update /repo/a.ts\nsecond\nthird\nfourth…')
    expect(shown()).not.toContain(detail)
    await act(async () => allow().props.onPress())
    act(() => toggle().props.onPress())
    expect(toggle().props.accessibilityState.expanded).toBe(true)
    expect(shown().filter((text) => text === detail)).toHaveLength(1)
    expect(shown()).not.toContain('update /repo/a.ts\nsecond\nthird\nfourth…')
    expect(shown()).toContain('Write access: /repo')
    expect(
      findAllByHostType(renderer!.root, 'Text').some((node) =>
        [node.props.children].flat().includes('Outside the sandbox')
      )
    ).toBe(true)
    const content = renderer!.root.findByProps({ testID: 'native-chat-approval-content' })
    expect(
      findAllByHostType(content, 'Text').some((node) =>
        [node.props.children].flat().includes('/outside/hidden.ts')
      )
    ).toBe(true)
    await act(async () => allow().props.onPress())
    expect(onRespond.mock.calls).toEqual([['accept'], ['accept']])
    act(() => toggle().props.onPress())
    expect(shown()).not.toContain(detail)
  })

  it('keeps compact command context visible without a redundant disclosure', async () => {
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatPermission, {
          permission: { title: 'Run a command?', detail: 'git status', options: [] },
          onRespond: vi.fn(async () => true)
        })
      )
    })
    expect(renderer!.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0)
    expect(renderer!.root.findByProps({ children: 'git status' }).props.selectable).toBe(true)
  })
})
