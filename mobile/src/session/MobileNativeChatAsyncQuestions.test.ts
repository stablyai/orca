import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatAsyncQuestions } from './MobileNativeChatAsyncQuestions'
import type { MobileNativeChatAsyncQuestionsModel } from './use-mobile-native-chat-async-questions'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ CircleHelp: 'CircleHelp', X: 'X' }))

function model(
  overrides: Partial<MobileNativeChatAsyncQuestionsModel> = {}
): MobileNativeChatAsyncQuestionsModel {
  return {
    open: [
      { key: 'a', index: 0, title: 'Which color?', options: ['Red', 'Blue'] },
      { key: 'b', index: 1, title: 'Anything else?' }
    ],
    omittedCount: 0,
    edits: {},
    held: new Set(),
    sending: false,
    canSend: false,
    edit: vi.fn(),
    dismiss: vi.fn(),
    submit: vi.fn(),
    ...overrides
  }
}

// The react-native mock renders host components as plain strings.
function byType(node: ReactTestInstance, type: string): ReactTestInstance[] {
  return node.findAll((candidate) => candidate.type === type)
}

function texts(renderer: ReactTestRenderer): string[] {
  return byType(renderer.root, 'Text')
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
}

describe('MobileNativeChatAsyncQuestions', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function mount(card: MobileNativeChatAsyncQuestionsModel): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatAsyncQuestions, { model: card }))
    })
    if (!renderer) {
      throw new Error('expected a renderer')
    }
    return renderer
  }

  it('renders every question, its choices and a free-text field', () => {
    const view = mount(model())
    expect(texts(view)).toEqual(
      expect.arrayContaining(['Which color?', 'Anything else?', 'Red', 'Blue', 'Send'])
    )
    expect(byType(view.root, 'TextInput')).toHaveLength(2)
  })

  it('picks a choice, types an answer and dismisses per question', () => {
    const card = model()
    const view = mount(card)
    const blue = byType(view.root, 'Pressable').find((node) =>
      byType(node, 'Text').some((text) => text.props.children === 'Blue')
    )
    act(() => blue?.props.onPress())
    expect(card.edit).toHaveBeenCalledWith('a', { option: 'Blue' })
    act(() => byType(view.root, 'TextInput')[1]?.props.onChangeText('no'))
    expect(card.edit).toHaveBeenCalledWith('b', { text: 'no' })
    const dismissals = view.root.findAllByProps({ accessibilityLabel: 'Dismiss' })
    act(() => dismissals.at(-1)?.props.onPress())
    expect(card.dismiss).toHaveBeenCalledWith('b')
  })

  it('enables Send only when allowed and locks input while sending', () => {
    const idle = mount(model())
    expect(idle.root.findByProps({ accessibilityLabel: 'Send answers' }).props.disabled).toBe(true)
    act(() =>
      idle.update(
        createElement(MobileNativeChatAsyncQuestions, { model: model({ sending: true }) })
      )
    )
    expect(texts(idle)).toContain('Sending…')
    expect(byType(idle.root, 'TextInput')[0]?.props.editable).toBe(false)
  })

  it('shows a held answer read-only while Dismiss and every other question stay usable', () => {
    const card = model({ edits: { a: { option: 'Red' } }, held: new Set(['a']) })
    const view = mount(card)
    const options = byType(view.root, 'Pressable').filter(
      (node) => node.props.accessibilityState !== undefined
    )
    expect(options.map((node) => node.props.disabled)).toEqual([true, true])
    expect(byType(view.root, 'TextInput').map((node) => node.props.editable)).toEqual([false, true])
    expect(texts(view)).toContain('Send')
    const dismissals = view.root.findAllByProps({ accessibilityLabel: 'Dismiss' })
    expect(dismissals.map((node) => node.props.disabled)).toEqual([false, false])
    act(() => dismissals[0]?.props.onPress())
    expect(card.dismiss).toHaveBeenCalledWith('a')
  })

  it('renders a choice the model repeated once per occurrence, each with its own key', () => {
    const keyWarning = vi.spyOn(console, 'error').mockImplementation(() => {})
    const options = byType(
      mount(model({ open: [{ key: 'a', index: 0, title: 'Pick', options: ['Yes', 'Yes'] }] })).root,
      'Pressable'
    ).filter((node) => node.props.accessibilityState !== undefined)
    expect(options).toHaveLength(2)
    expect(keyWarning.mock.calls.flat().join(' ')).not.toContain('same key')
    keyWarning.mockRestore()
  })

  it('says how many questions were left out of the published set, singular for one', () => {
    expect(texts(mount(model({ omittedCount: 1 })))).toContain('1 more question in the transcript')
    act(() => renderer?.unmount())
    expect(texts(mount(model({ omittedCount: 2 })))).toContain('2 more questions in the transcript')
  })

  it('renders nothing when no question is open', () => {
    expect(mount(model({ open: [] })).toJSON()).toBeNull()
  })
})
