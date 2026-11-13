import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import type { AskPrompt } from '../../../../../src/shared/native-chat/input/native-chat-ask-types'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  Platform: { select: (options: { ios: unknown }) => options.ios },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({ Check: 'Check' }))
vi.mock('../../../components/composer-input/MessageBox', () => ({ MessageBox: 'MessageBox' }))
vi.mock('../transcript/MobileNativeChatQuestionText', () => ({
  MobileNativeChatQuestionText: 'QuestionText'
}))
vi.mock('./MobileNativeChatCardHeaderAction', () => ({
  MobileNativeChatCardHeaderAction: () => null
}))
vi.mock('../../../components/bottom-drawer/keyed-bottom-drawer', () => ({
  KeyedBottomDrawer: ({
    sheet,
    children
  }: {
    sheet: number | null
    children: (index: number) => ReactNode
  }) => (sheet === null ? null : children(sheet))
}))
vi.mock('../../../components/nav-bar/SheetHeader', () => ({
  SheetHeader: ({ onClose }: { onClose: () => void }) =>
    createElement('button', { accessibilityLabel: 'Close viewer', onPress: onClose })
}))

let renderer: ReactTestRenderer
function prompt(multiSelect = false): AskPrompt {
  return {
    questions: [
      {
        question: 'Which layout?',
        header: 'Layout',
        multiSelect,
        options: [
          { label: 'First', preview: 'A\t|\n𠀀\t|' },
          { label: 'No preview' },
          { label: 'Last', preview: 'Last preview body' }
        ]
      }
    ]
  }
}
function buttons(): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) => String(node.type) === 'Pressable' || String(node.type) === 'button'
  )
}
function button(label: string): ReactTestInstance {
  return buttons().find((node) => node.props.accessibilityLabel === label)!
}
function row(index: number): ReactTestInstance {
  return buttons().filter((node) => ['radio', 'checkbox'].includes(node.props.accessibilityRole))[
    index
  ]!
}
function textAction(label: string): ReactTestInstance {
  return buttons().find((node) =>
    node
      .findAll((child) => String(child.type) === 'Text')
      .some((text) => text.children.includes(label))
  )!
}
function press(node: ReactTestInstance): void {
  act(() => node.props.onPress())
}
type Answer = Parameters<typeof MobileNativeChatAsk>[0]['onAnswer']
function mount(value: AskPrompt): Mock<Answer> {
  const onAnswer = vi.fn<Answer>(async () => true)
  act(() => {
    renderer = create(createElement(MobileNativeChatAsk, { prompt: value, onAnswer }))
  })
  return onAnswer
}

afterEach(() => {
  act(() => renderer?.unmount())
  vi.useRealTimers()
})

it('inspects every preview without choosing, and keeps the original option when choosing and submitting', async () => {
  vi.useFakeTimers()
  const onAnswer = mount(prompt())
  expect(row(2).props.accessibilityState.checked).toBe(false)
  press(button('First preview'))
  // Paging crosses the option with no preview; inspection does not change the answer.
  press(
    buttons().find(
      (node) => node.props.accessibilityLabel === 'Last preview' && node.props.accessibilityState
    )!
  )
  press(button('Close viewer'))
  act(() => {
    vi.runAllTimers()
  })
  expect(onAnswer).not.toHaveBeenCalled()
  expect(row(2).props.accessibilityState.checked).toBe(false)
  press(button('Last preview'))
  press(button('Choose this'))
  act(() => {
    vi.runAllTimers()
  })
  expect(row(2).props.accessibilityState.checked).toBe(true)
  expect(onAnswer).not.toHaveBeenCalled()
  press(button('Last preview'))
  press(button('Chosen'))
  press(row(2))
  expect(row(2).props.accessibilityState.checked).toBe(true)
  await act(async () => textAction('Submit').props.onPress())
  expect(onAnswer).toHaveBeenCalledWith([{ indices: [2] }], expect.any(Function))
})
