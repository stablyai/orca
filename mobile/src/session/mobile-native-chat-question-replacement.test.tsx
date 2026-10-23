import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskPrompt } from '../../../src/shared/native-chat-ask'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../src/shared/native-chat-question-auto-advance'
import { MobileNativeChatPromptCard } from './MobileNativeChatPromptCard'
import { mobileNativeChatPromptDismissals } from './mobile-native-chat-prompt-dismissals'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios }
}))
vi.mock('lucide-react-native', () => ({ Check: 'Check', ChevronDown: 'ChevronDown' }))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'Markdown' }))

const first: AskPrompt = {
  questions: [{ question: 'Original question?', multiSelect: false, options: [{ label: 'East' }] }]
}
const replacement: AskPrompt = {
  questions: [
    { question: 'Replacement question?', multiSelect: false, options: [{ label: 'West' }] }
  ]
}
const isHost = (node: { type: unknown }, name: string): boolean => node.type === name

describe('question replacement during pending actions', () => {
  let tree: ReactTestRenderer | undefined
  const answer = vi.fn(async () => true)
  const cancel = vi.fn(async () => true)

  function Harness({ prompt }: { prompt: AskPrompt }): React.JSX.Element | null {
    const dismissal = useMobileNativeChatAskDismiss({
      ask: prompt,
      detectedAsk: prompt,
      scopeKey: 'replacement-tab',
      sessionKey: 'replacement-session',
      observing: true
    })
    return dismissal.showAsk
      ? createElement(MobileNativeChatPromptCard, {
          ask: prompt,
          askKey: dismissal.askKey,
          onDismissAsk: dismissal.dismissAsk,
          onAnswerAsk: answer,
          onCancelAsk: cancel
        })
      : null
  }

  const root = () => {
    if (!tree) {
      throw new Error('Question not mounted')
    }
    return tree.root
  }
  const input = () => root().findByProps({ placeholder: 'Type your answer' })
  const press = (label: string) => {
    act(() => root().findByProps({ label }).props.onPress())
  }
  const action = (label: string) =>
    root().find(
      (node) =>
        isHost(node, 'Pressable') &&
        node.findAll((child) => isHost(child, 'Text') && child.props.children === label).length > 0
    )
  const update = (prompt: AskPrompt) => {
    act(() => tree?.update(createElement(Harness, { prompt })))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    mobileNativeChatPromptDismissals.clearForTests()
    answer.mockReset().mockResolvedValue(true)
    cancel.mockReset().mockResolvedValue(true)
    act(() => {
      tree = create(createElement(Harness, { prompt: first }))
    })
  })
  afterEach(() => {
    act(() => tree?.unmount())
    tree = undefined
    vi.useRealTimers()
  })

  it('cancels the old auto-advance without answering the replacement', async () => {
    press('East')
    update(replacement)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
    })
    expect(answer).not.toHaveBeenCalled()
    expect(root().findByProps({ label: 'West' }).props.selected).toBe(false)
  })

  it.each([
    ['Submit', true],
    ['Submit', false],
    ['Cancel', true],
    ['Cancel', false]
  ] as const)('keeps the replacement draft after old %s settles (%s)', async (label, accepted) => {
    let settle: (result: boolean) => void = () => {}
    const pending = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    if (label === 'Submit') {
      answer.mockReturnValueOnce(pending)
    } else {
      cancel.mockReturnValueOnce(pending)
    }
    press('Other…')
    act(() => input().props.onChangeText('Original draft'))
    act(() => {
      void action(label).props.onPress()
    })
    expect(input().props.editable).toBe(false)

    update(replacement)
    press('Other…')
    expect(input().props.value).toBe('')
    act(() => input().props.onChangeText('Replacement draft'))
    await act(async () => settle(accepted))

    expect(input().props.value).toBe('Replacement draft')
    expect(input().props.editable).toBe(true)
    expect(action('Submit').props.disabled).toBe(false)
    expect(answer).toHaveBeenCalledTimes(label === 'Submit' ? 1 : 0)
    expect(cancel).toHaveBeenCalledTimes(label === 'Cancel' ? 1 : 0)
  })
})
