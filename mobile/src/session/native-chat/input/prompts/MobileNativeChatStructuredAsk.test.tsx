import { createElement } from 'react'
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { createWithQueryClient } from '../../../../test-support/query-client-test-renderer'
import { decodeAgentSessionQuestionAnswers } from '../../../../../../src/shared/agent-session/agent-session-question-answer'
import type { AgentJournalQuestion } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../../../src/shared/native-chat/input/questions/native-chat-question-auto-advance'
import { MobileNativeChatStructuredAsk } from './MobileNativeChatStructuredAsk'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
}))
vi.mock('react-native', () => ({
  Keyboard: { dismiss: () => {} },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios }
}))
vi.mock('lucide-react-native', () => ({ Check: 'Check', ChevronDown: 'ChevronDown', X: 'X' }))
// Leaves that load native modules; the question text renders as plain Text so steps can be read.
vi.mock('../../transcript/message-content/MobileNativeChatQuestionText', async () => {
  const React = await import('react')
  return {
    MobileNativeChatQuestionText: ({ content }: { content: string }) =>
      React.createElement('Text', null, content)
  }
})
vi.mock('../../../../components/composer-input/MessageBox', () => ({ MessageBox: 'MessageBox' }))
vi.mock('../session-options/MobileNativeChatOptionPreviewSheet', () => ({
  MobileNativeChatOptionPreviewSheet: 'OptionPreviewSheet'
}))

let tree: ReactTestRenderer

afterEach(() => {
  act(() => tree.unmount())
  vi.useRealTimers()
})

const question = (n: number, skippable: boolean): AgentJournalQuestion => ({
  id: `q${n}`,
  question: `Question ${n}?`,
  multiSelect: false,
  options: [
    { id: `q${n}:a`, label: `${n} A` },
    { id: `q${n}:b`, label: `${n} B` }
  ],
  ...(skippable ? { skippable: true as const } : {})
})

const isHost = (node: { type: unknown }, name: string): boolean => node.type === name
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const shows = (text: string): boolean =>
  tree.root.findAll((node) => isHost(node, 'Text') && textOf(node) === text).length > 0
const footer = (label: string): ReactTestInstance =>
  tree.root.find(
    (node) =>
      isHost(node, 'Pressable') && node.findAll((n) => n.props.children === label).length > 0
  )

async function pick(label: string): Promise<void> {
  const row = tree.root.find((node) => node.props.label === label)
  act(() => row.props.onPress())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
  })
}

it('offers no Skip on a required question and takes Submit back to it instead of sending', async () => {
  vi.useFakeTimers()
  const onAnswer = vi.fn(async (_encoded: string) => true)
  act(() => {
    tree = createWithQueryClient(
      createElement(MobileNativeChatStructuredAsk, {
        questions: [question(1, true), question(2, false), question(3, true)],
        onAnswer
      })
    )
  })

  await pick('1 B')
  expect(shows('Question 2?')).toBe(true)
  expect(footer('Next').props.disabled).toBe(true)

  // Jumping past it by its step tab: Submit returns to it rather than sending.
  const tab = tree.root.find(
    (node) =>
      isHost(node, 'Pressable') && node.findAll((n) => n.props.children === 'Step 3').length > 0
  )
  act(() => tab.props.onPress())
  await act(async () => footer('Submit').props.onPress())
  expect(onAnswer).not.toHaveBeenCalled()
  expect(shows('Question 2?')).toBe(true)

  await pick('2 A')
  expect(footer('Submit').props.disabled).toBe(false)
  await act(async () => footer('Submit').props.onPress())
  expect(decodeAgentSessionQuestionAnswers(onAnswer.mock.calls[0]![0])).toEqual([
    { questionId: 'q1', optionIds: ['q1:b'] },
    { questionId: 'q2', optionIds: ['q2:a'] },
    { questionId: 'q3', optionIds: [] }
  ])
})

it('keeps Submit idle on an unanswered required last question', async () => {
  vi.useFakeTimers()
  act(() => {
    tree = createWithQueryClient(
      createElement(MobileNativeChatStructuredAsk, {
        questions: [question(1, true), question(2, false)],
        onAnswer: vi.fn(async () => true)
      })
    )
  })

  await pick('1 B')
  expect(shows('Question 2?')).toBe(true)
  expect(footer('Submit').props.disabled).toBe(true)
})
