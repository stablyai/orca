import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ ShieldQuestion: 'ShieldQuestion', X: 'X' }))

describe('MobileNativeChatPermission', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('accepts only one response when two presses land in the same render batch', async () => {
    let resolveResponse: (accepted: boolean) => void = () => {}
    const response = new Promise<boolean>((resolve) => (resolveResponse = resolve))
    const onRespond = vi.fn(() => response)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatPermission, {
          permission: { title: 'Approve?', options: [{ label: 'Allow', send: '1' }] },
          onRespond
        })
      )
    })
    const button = renderer.root.findByType('Pressable')

    act(() => {
      button.props.onPress()
      button.props.onPress()
    })

    expect(onRespond).toHaveBeenCalledOnce()
    await act(async () => resolveResponse(true))
  })

  it('passes the rendered prompt identity to cancel', async () => {
    const onCancel = vi.fn(async () => true)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatPermission, {
          permission: {
            title: 'Approve?',
            prompt: { itemId: 'approval-1', expectedRevision: 4 },
            options: [{ label: 'Allow', send: '1' }]
          },
          onRespond: vi.fn(async () => true),
          onCancel
        })
      )
    })
    const cancel = renderer.root.findByProps({ accessibilityLabel: 'Cancel' })
    await act(async () => cancel.props.onPress())
    expect(onCancel).toHaveBeenCalledWith({ itemId: 'approval-1', expectedRevision: 4 })
  })

  it('keeps oversized provider context in a bounded scroller above the actions', async () => {
    const description = `Workspace access ${'description '.repeat(400)}`
    const decisionReason = `Outside the allowed root ${'reason '.repeat(400)}`
    const blockedPath = `/repo/${'nested/'.repeat(400)}secrets.txt`
    const ruleContent = `/repo/${'**/'.repeat(400)}`
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatPermission, {
          permission: {
            title: 'Claude wants to read secrets.txt '.repeat(400),
            description,
            decisionReason,
            blockedPath,
            matchedAskRule: { source: 'project', toolName: 'Read', ruleContent },
            options: [{ label: 'Allow', send: '1' }]
          },
          onRespond: vi.fn(async () => true)
        })
      )
    })

    const card = renderer.root.findByProps({ testID: 'native-chat-approval-card' })
    const title = renderer.root.findByProps({ testID: 'native-chat-approval-title' })
    const content = renderer.root.findByProps({ testID: 'native-chat-approval-content' })
    const actions = renderer.root.findByProps({ testID: 'native-chat-approval-actions' })
    const contentText = content.findAllByType('Text')
    const containsText = (value: string): boolean =>
      contentText.some((node) => {
        const children = Array.isArray(node.props.children)
          ? node.props.children
          : [node.props.children]
        return children.includes(value)
      })

    expect(card.props.style).toMatchObject({ flexShrink: 1, minHeight: 0 })
    expect(title.props).toMatchObject({ numberOfLines: 2, ellipsizeMode: 'tail' })
    expect(content.props.style).toMatchObject({ maxHeight: 240, minHeight: 0, flexShrink: 1 })
    expect(containsText(description)).toBe(true)
    expect(containsText(decisionReason)).toBe(true)
    expect(containsText(blockedPath)).toBe(true)
    expect(containsText(ruleContent)).toBe(true)
    expect(content.findAllByProps({ children: 'Allow' })).toHaveLength(0)
    expect(actions.findAllByProps({ children: 'Allow' })).toHaveLength(1)
    expect(actions.props.style).toMatchObject({ flexShrink: 0 })
  })
})
