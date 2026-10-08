import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskPrompt } from '../../../src/shared/native-chat-ask'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../src/shared/native-chat-question-auto-advance'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'

vi.mock('react-native', () => ({
  Keyboard: { dismiss: () => {} },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios }
}))
vi.mock('lucide-react-native', () => ({ Check: 'Check', ChevronDown: 'ChevronDown', X: 'X' }))

const indent = {
  question: 'Tabs or spaces?',
  multiSelect: false,
  options: [{ label: 'Tabs' }, { label: 'Spaces' }]
}
const fruit = {
  question: 'Which fruit?',
  multiSelect: false,
  options: [{ label: 'Apple' }, { label: 'Banana' }]
}

let tree: ReactTestRenderer

function render(prompt: AskPrompt, onAnswer = vi.fn(async () => true)): typeof onAnswer {
  vi.useFakeTimers()
  act(() => {
    tree = create(
      createElement(MobileNativeChatAsk, { prompt, onAnswer, onCancel: async () => true })
    )
  })
  return onAnswer
}

function press(label: string): void {
  const row = tree.root.find((node) => node.props.label === label)
  act(() => row.props.onPress())
}

async function passAutoAdvanceBeat(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
  })
}

// The react-native mock above renders host components as plain strings.
const isHost = (node: { type: unknown }, name: string): boolean => node.type === name

const shows = (text: string): boolean =>
  tree.root.findAll((node) => isHost(node, 'Text') && node.props.children === text).length > 0

afterEach(() => {
  act(() => tree.unmount())
  vi.useRealTimers()
})

describe('MobileNativeChatAsk single-select auto-advance', () => {
  it('moves to the next question after a pick and sends after the last one', async () => {
    const onAnswer = render({ questions: [indent, fruit] })

    press('Spaces')
    expect(shows('Tabs or spaces?')).toBe(true)
    await passAutoAdvanceBeat()
    expect(shows('Which fruit?')).toBe(true)
    expect(onAnswer).not.toHaveBeenCalled()
    press('Apple')
    await passAutoAdvanceBeat()

    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [1] }, { indices: [0] }])
  })

  it('waits for the typed text when "Other…" is picked', async () => {
    const onAnswer = render({ questions: [indent] })

    press('Other…')
    await passAutoAdvanceBeat()

    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('waits for Submit on a multi-select question', async () => {
    const onAnswer = render({ questions: [{ ...fruit, multiSelect: true }] })

    press('Apple')
    await passAutoAdvanceBeat()

    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('holds its choices while an answer is being delivered', async () => {
    const onAnswer = render(
      { questions: [indent] },
      vi.fn(() => new Promise<boolean>(() => {}))
    )
    const row = (label: string) => tree.root.find((node) => node.props.label === label)

    press('Tabs')
    await passAutoAdvanceBeat()
    press('Spaces')
    await passAutoAdvanceBeat()

    expect(row('Spaces').props).toMatchObject({ selected: false, disabled: true })
    expect(row('Tabs').props.selected).toBe(true)
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [0] }])
  })

  it('sends nothing when the question is cancelled before the pick moves on', async () => {
    const onAnswer = render({ questions: [indent] })

    press('Spaces')
    const cancel = tree.root.find(
      (node) =>
        isHost(node, 'Pressable') && node.findAll((n) => n.props.children === 'Cancel').length > 0
    )
    await act(async () => cancel.props.onPress())
    await passAutoAdvanceBeat()

    expect(onAnswer).not.toHaveBeenCalled()
  })
})
