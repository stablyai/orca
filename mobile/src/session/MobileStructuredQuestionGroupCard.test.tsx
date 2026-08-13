import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalQuestion } from '../../../src/shared/agent-session-journal-types'
import { decodeAgentSessionQuestionAnswers } from '../../../src/shared/agent-session-question-answer'
import { MobileStructuredQuestionGroupCard } from './MobileStructuredQuestionGroupCard'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  CircleHelp: 'CircleHelp'
}))

const questions: AgentJournalQuestion[] = [
  {
    id: 'q1',
    question: 'Targets?',
    options: [
      { id: 'q1:choice-1', label: 'Web' },
      { id: 'q1:choice-2', label: 'Mobile' }
    ],
    multiSelect: true,
    freeTextQuestionId: 'q1'
  },
  {
    id: 'q2',
    question: 'Mode?',
    options: [
      { id: 'q2:choice-1', label: 'Fast' },
      { id: 'q2:choice-2', label: 'Safe' }
    ],
    multiSelect: false,
    freeTextQuestionId: 'q2'
  },
  {
    id: 'q3',
    question: 'Other?',
    options: [],
    multiSelect: false,
    freeTextQuestionId: 'q3'
  }
]

describe('MobileStructuredQuestionGroupCard', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('keeps per-step state and submits the mixed group only after the last answer', async () => {
    const onAnswer = vi.fn(async () => true)
    await act(async () => {
      renderer = create(createElement(MobileStructuredQuestionGroupCard, { questions, onAnswer }))
    })
    const pressOptions = (): ReactTestInstance[] =>
      renderer!.root.findAll(
        (node) => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox'
      )
    await act(async () => {
      pressOptions()[0]!.props.onPress()
      pressOptions()[1]!.props.onPress()
    })
    await act(async () => {
      renderer!.root.findByProps({ accessibilityLabel: 'Next question' }).props.onPress()
    })
    const singleOptions = renderer!.root.findAll(
      (node) => node.type === 'Pressable' && node.props.accessibilityRole === 'button'
    )
    await act(async () => {
      singleOptions[1]!.props.onPress()
    })
    await act(async () => {
      renderer!.root.findByProps({ accessibilityLabel: 'Next question' }).props.onPress()
    })
    await act(async () => {
      renderer!.root.findByType('TextInput').props.onChangeText('SSH host')
    })
    await act(async () => {
      renderer!.root.findByProps({ accessibilityLabel: 'Submit answers' }).props.onPress()
    })

    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(decodeAgentSessionQuestionAnswers(onAnswer.mock.calls[0]![0])).toEqual([
      { questionId: 'q1', optionIds: ['q1:choice-1', 'q1:choice-2'] },
      { questionId: 'q2', optionIds: ['q2:choice-2'] },
      { questionId: 'q3', optionIds: [], other: 'SSH host' }
    ])
  })
})
