import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import type {
  NativeChatAnswerSource,
  AskAnswerSelection
} from '../../../../../src/shared/native-chat/input/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../src/shared/native-chat/input/native-chat-ask-types'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../../src/shared/native-chat/input/native-chat-question-auto-advance'
import { encodeAgentSessionQuestionAnswers } from '../../../../../src/shared/agent-session/agent-session-question-answer'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import { MobileNativeChatStructuredAsk } from './MobileNativeChatStructuredAsk'

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

function render(
  prompt: AskPrompt,
  onAnswer = vi.fn(async () => true),
  onCancel = vi.fn(async () => true)
): typeof onAnswer {
  vi.useFakeTimers()
  act(() => {
    tree = create(createElement(MobileNativeChatAsk, { prompt, onAnswer, onCancel }))
  })
  return onAnswer
}

function press(label: string): void {
  const row = tree.root.find((node) => node.props.label === label)
  act(() => row.props.onPress())
}

async function submit(label = 'Submit'): Promise<void> {
  const button = tree.root.find(
    (node) =>
      isHost(node, 'Pressable') && node.findAll((n) => n.props.children === label).length > 0
  )
  expect(button.props.disabled).toBe(false)
  await act(async () => button.props.onPress())
}

async function passAutoAdvanceBeat(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
  })
}

const isHost = (node: { type: unknown }, name: string): boolean => node.type === name

const shows = (text: string): boolean =>
  tree.root.findAll((node) => isHost(node, 'Text') && node.props.children === text).length > 0

afterEach(() => {
  act(() => tree.unmount())
  vi.useRealTimers()
})

describe('MobileNativeChatAsk single-select auto-advance', () => {
  it.each([1000, 10000])(
    'does not revisit unchanged delivery history while editing after failure (%i rows)',
    async (count) => {
      const prompt: AskPrompt = {
        source: 'transcript',
        questions: [indent],
        replyAsMessage: true
      }
      let messageReads = 0
      let submissionReads = 0
      const messages: NativeChatAnswerSource['messages'] = Array.from(
        { length: count },
        (_, index) => ({
          get id() {
            messageReads++
            return `history-${index}`
          },
          role: 'assistant',
          source: 'transcript',
          timestamp: index,
          blocks: []
        })
      )
      const submissions: NativeChatAnswerSource['submissions'] = Array.from(
        { length: count },
        (_, index) => ({
          get clientMessageId() {
            submissionReads++
            return `old-${index}`
          },
          fence: 1,
          payloadFingerprint: String(index),
          dispatchState: 'unknown',
          providerItemId: null,
          reason: null,
          submittedAt: index,
          resolvedAt: null
        })
      )
      let source: NativeChatAnswerSource = { messages, submissions }
      const onAnswer = vi.fn(
        async (_selections: AskAnswerSelection[], onCreated?: (id: string) => void) => {
          onCreated?.('answer')
          return false
        }
      )
      vi.useFakeTimers()
      const update = () =>
        act(() =>
          tree.update(
            createElement(MobileNativeChatAsk, { prompt, onAnswer, answerSendSource: source })
          )
        )
      act(() => {
        tree = create(
          createElement(MobileNativeChatAsk, { prompt, onAnswer, answerSendSource: source })
        )
      })
      press('Spaces')
      await passAutoAdvanceBeat()
      expect(messageReads).toBe(count)
      expect(submissionReads).toBe(count)
      messageReads = submissionReads = 0
      press('Other…')
      for (let index = 0; index < 10; index++) {
        act(() =>
          tree.root
            .find((node) => isHost(node, 'TextInput'))
            .props.onChangeText(`More detail ${index}`)
        )
      }
      expect(messageReads).toBe(0)
      expect(submissionReads).toBe(0)
      const disabled = () =>
        tree.root.find(
          (node) =>
            isHost(node, 'Pressable') &&
            node.findAll((n) => n.props.children === 'Submit').length > 0
        ).props.disabled
      source = {
        messages: [
          ...messages,
          {
            id: agentJournalSubmissionKey('answer'),
            role: 'user',
            source: 'transcript',
            timestamp: 1,
            blocks: [],
            deliveryState: 'pending'
          }
        ],
        submissions
      }
      update()
      expect(disabled()).toBe(true)
      expect(messageReads).toBeGreaterThan(0)
      source = {
        ...source,
        submissions: [
          ...submissions,
          {
            clientMessageId: 'answer',
            fence: 1,
            payloadFingerprint: 'answer',
            dispatchState: 'unknown',
            providerItemId: null,
            reason: null,
            submittedAt: 1,
            resolvedAt: null
          }
        ]
      }
      update()
      expect(disabled()).toBe(false)
      source = { messages, submissions }
      update()
      expect(disabled()).toBe(false)
      expect(tree.root.find((node) => isHost(node, 'TextInput')).props.value).toBe('More detail 9')
    }
  )

  it('owns the RPC-first echo and releases canonical uncertainty before an old reply can clear a retry', async () => {
    const prompt: AskPrompt = {
      source: 'transcript',
      questions: [indent],
      replyAsMessage: true
    }
    let source: NativeChatAnswerSource = { messages: [], submissions: [] }
    const replies: (() => void)[] = []
    const onAnswer = vi.fn(
      (_selections: AskAnswerSelection[], onCreated?: (id: string) => void) => {
        onCreated?.(['answer', 'retry', 'newer'][replies.length]!)
        return new Promise<boolean>((resolve) => replies.push(() => resolve(true)))
      }
    )
    vi.useFakeTimers()
    const update = () =>
      act(() =>
        tree.update(
          createElement(MobileNativeChatAsk, { prompt, onAnswer, answerSendSource: source })
        )
      )
    act(() => {
      tree = create(
        createElement(MobileNativeChatAsk, { prompt, onAnswer, answerSendSource: source })
      )
    })
    press('Spaces')
    await passAutoAdvanceBeat()
    const button = () =>
      tree.root.find(
        (node) =>
          isHost(node, 'Pressable') && node.findAll((n) => n.props.children === 'Submit').length > 0
      )
    expect(button().props.disabled).toBe(true)
    source = {
      messages: [
        {
          id: agentJournalSubmissionKey('answer'),
          role: 'user',
          source: 'transcript',
          blocks: [],
          timestamp: 2,
          deliveryState: 'pending'
        }
      ],
      submissions: []
    }
    update()
    await act(async () => replies[0]!())
    expect(button().props.disabled).toBe(true)
    source = { messages: [], submissions: [] }
    update()
    expect(button().props.disabled).toBe(false)
    act(() => button().props.onPress())
    source = {
      messages: [],
      submissions: [
        {
          clientMessageId: 'retry',
          fence: 1,
          payloadFingerprint: 'retry',
          dispatchState: 'unknown',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: null
        }
      ]
    }
    update()
    expect(button().props.disabled).toBe(false)
    act(() => button().props.onPress())
    expect(onAnswer).toHaveBeenCalledTimes(3)
    await act(async () => replies[1]!())
    // The third action has a distinct operation id on the actual sender; use it here too.
    source = { messages: [], submissions: [] }
    update()
    expect(button().props.disabled).toBe(true)
    expect(tree.root.find((node) => node.props.label === 'Spaces').props.selected).toBe(true)
    await act(async () => replies[2]!())
  })

  it('keeps the picked answer disabled after admission and retryable when delivery is unconfirmed', async () => {
    const prompt: AskPrompt = {
      source: 'transcript',
      questions: [indent],
      replyAsMessage: true
    }
    const onAnswer = render(prompt)
    press('Spaces')
    await passAutoAdvanceBeat()
    act(() =>
      tree.update(createElement(MobileNativeChatAsk, { prompt, onAnswer, answerPending: true }))
    )
    expect(tree.root.find((node) => node.props.label === 'Spaces').props.selected).toBe(true)
    const button = (label: string) =>
      tree.root.find(
        (node) =>
          isHost(node, 'Pressable') && node.findAll((n) => n.props.children === label).length > 0
      )
    expect(button('Submit').props.disabled).toBe(true)
    expect(button('Cancel').props.disabled).toBe(false)
    press('Tabs')
    expect(tree.root.find((node) => node.props.label === 'Spaces').props.selected).toBe(true)
    expect(onAnswer).toHaveBeenCalledTimes(1)
    act(() =>
      tree.update(createElement(MobileNativeChatAsk, { prompt, onAnswer, answerPending: false }))
    )
    await submit()
    expect(onAnswer).toHaveBeenCalledTimes(2)
    expect(onAnswer).toHaveBeenLastCalledWith([{ indices: [1] }], expect.any(Function))
  })

  it.each([false, true])(
    'cancels a scheduled step when delivery becomes pending (multiple: %s)',
    async (multiple) => {
      const prompt: AskPrompt = {
        source: 'transcript',
        questions: multiple ? [indent, fruit] : [indent],
        replyAsMessage: true
      }
      const onAnswer = render(prompt)
      press('Spaces')
      act(() =>
        tree.update(createElement(MobileNativeChatAsk, { prompt, onAnswer, answerPending: true }))
      )
      await passAutoAdvanceBeat()
      expect(onAnswer).not.toHaveBeenCalled()
      expect(shows('Tabs or spaces?')).toBe(true)
      expect(shows('Which fruit?')).toBe(false)
      expect(tree.root.find((node) => node.props.label === 'Spaces').props.selected).toBe(true)
      act(() =>
        tree.update(createElement(MobileNativeChatAsk, { prompt, onAnswer, answerPending: false }))
      )
      await submit(multiple ? 'Next' : 'Submit')
      if (multiple) {
        expect(shows('Which fruit?')).toBe(true)
      } else {
        expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [1] }], expect.any(Function))
      }
    }
  )

  it('moves to the next question after a pick and sends after the last one', async () => {
    const onAnswer = render({ questions: [indent, fruit] })

    press('Spaces')
    expect(shows('Tabs or spaces?')).toBe(true)
    await passAutoAdvanceBeat()
    expect(shows('Which fruit?')).toBe(true)
    expect(onAnswer).not.toHaveBeenCalled()
    press('Apple')
    await passAutoAdvanceBeat()

    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(
      [{ indices: [1] }, { indices: [0] }],
      expect.any(Function)
    )
  })

  it('waits for the typed text when "Other…" is picked', async () => {
    const onAnswer = render({ questions: [indent] })

    press('Other…')
    await passAutoAdvanceBeat()

    expect(onAnswer).not.toHaveBeenCalled()
    const input = tree.root.find((node) => isHost(node, 'TextInput'))
    act(() => input.props.onChangeText('  custom answer  '))
    await passAutoAdvanceBeat()
    expect(onAnswer).not.toHaveBeenCalled()
    await submit()
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(
      [{ indices: [], other: 'custom answer' }],
      expect.any(Function)
    )
  })

  it('waits for Submit on a multi-select question', async () => {
    const onAnswer = render({ questions: [{ ...fruit, multiSelect: true }] })

    press('Apple')
    await passAutoAdvanceBeat()

    expect(onAnswer).not.toHaveBeenCalled()
    await submit()
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [0] }], expect.any(Function))
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
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [0] }], expect.any(Function))
  })

  it('sends the answered questions when the last one is skipped', async () => {
    const onAnswer = render({ questions: [indent, fruit] })

    press('Tabs')
    await passAutoAdvanceBeat()
    await submit('Skip')

    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(
      [{ indices: [0] }, { indices: [] }],
      expect.any(Function)
    )
  })

  it('cancels the prompt when every question is skipped', async () => {
    const onCancel = vi.fn(async () => true)
    const onAnswer = render(
      { questions: [indent] },
      vi.fn(async () => true),
      onCancel
    )

    await submit('Skip')

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('sends nothing when the question is cancelled before the pick moves on', async () => {
    const onCancel = vi.fn(async () => true)
    const onAnswer = render(
      { questions: [indent] },
      vi.fn(async () => true),
      onCancel
    )

    press('Spaces')
    const cancel = tree.root.find(
      (node) =>
        isHost(node, 'Pressable') && node.findAll((n) => n.props.children === 'Cancel').length > 0
    )
    await act(async () => cancel.props.onPress())
    expect(onCancel).toHaveBeenCalledExactlyOnceWith()
    await passAutoAdvanceBeat()

    expect(onAnswer).not.toHaveBeenCalled()
  })
})

describe('MobileNativeChatStructuredAsk', () => {
  it('lets an earlier question change before the whole set is sent', async () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn(async () => true)
    const options = (id: string, labels: string[]) =>
      labels.map((label, i) => ({ id: `${id}:${i}`, label }))
    act(() => {
      tree = create(
        createElement(MobileNativeChatStructuredAsk, {
          questions: [
            {
              id: 'q1',
              question: 'Tabs or spaces?',
              multiSelect: false,
              options: options('q1', ['Tabs', 'Spaces'])
            },
            {
              id: 'q2',
              question: 'Which fruit?',
              multiSelect: false,
              options: options('q2', ['Apple', 'Banana'])
            }
          ],
          onAnswer
        })
      )
    })

    press('Tabs')
    await passAutoAdvanceBeat()
    const firstTab = tree.root.find(
      (node) =>
        isHost(node, 'Pressable') && node.findAll((n) => n.props.children === 'Step 1').length > 0
    )
    act(() => firstTab.props.onPress())
    press('Spaces')
    await passAutoAdvanceBeat()
    press('Banana')
    await passAutoAdvanceBeat()

    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(
      encodeAgentSessionQuestionAnswers([
        { questionId: 'q1', optionIds: ['q1:1'] },
        { questionId: 'q2', optionIds: ['q2:1'] }
      ])
    )
  })
})
