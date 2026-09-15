import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskPrompt } from '../../../src/shared/native-chat-ask'
import { MobileNativeChatPromptCard } from './MobileNativeChatPromptCard'
import type { MobileAsyncAskPrompt } from './mobile-native-chat-async-ask'
import { useMobileNativeChatAskActions } from './use-mobile-native-chat-ask-actions'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ArrowUp: 'ArrowUp',
  CircleHelp: 'CircleHelp',
  ShieldQuestion: 'ShieldQuestion'
}))
const blocking = {
  answer: vi.fn(async () => true),
  cancel: vi.fn(async () => true)
}

const prompt: MobileAsyncAskPrompt = {
  asyncCallIds: ['async-1'],
  questions: [
    {
      question: 'Which color?',
      multiSelect: false,
      options: [{ label: 'Red (Recommended)' }, { label: 'Blue' }]
    },
    { question: 'Any constraints?', multiSelect: false, options: [] }
  ]
}

describe('mobile async decision card', () => {
  let renderer: ReactTestRenderer | null = null
  let composer = ''
  let actions: ReturnType<typeof useMobileNativeChatAskActions>
  const resolved = vi.fn()
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })
  function Harness({
    activePrompt = prompt,
    session = 'session'
  }: {
    activePrompt?: AskPrompt
    session?: string
  }) {
    const [text, setText] = useState('Existing draft')
    const [dismissed, setDismissed] = useState(false)
    composer = text
    actions = useMobileNativeChatAskActions({
      prompt: activePrompt,
      setComposerText: setText,
      onSendResolved: resolved,
      streamIdentity: `host:${session}`,
      answerBlocking: blocking.answer,
      cancelBlocking: blocking.cancel
    })
    return (
      <MobileNativeChatPromptCard
        ask={dismissed ? null : activePrompt}
        onAnswerAsk={actions.answer}
        onCancelAsk={actions.cancel}
        onDismissAsk={() => setDismissed(true)}
      />
    )
  }
  async function mount(activePrompt: AskPrompt = prompt) {
    await act(async () => {
      renderer = create(createElement(Harness, { activePrompt }))
    })
  }
  function button(label: string) {
    return renderer!.root
      .findAllByType('Pressable')
      .find((node) => node.findAllByType('Text').some((text) => text.children.join('') === label))!
  }
  async function press(label: string) {
    await act(async () => button(label).props.onPress())
  }

  it('collects a non-default choice and free text into the preserved composer without sending', async () => {
    await mount()
    expect(button('Next').props.disabled).toBe(true)
    await press('Blue')
    await press('Next')
    await press('Other…')
    await act(async () => renderer!.root.findByType('TextInput').props.onChangeText('No gradients'))
    expect(button('Add to message').props.disabled).toBe(false)
    await press('Add to message')
    expect(composer).toBe('Existing draft\n\nWhich color?\nBlue\n\nAny constraints?\nNo gradients')
    expect(renderer!.toJSON()).toBeNull()
    expect(blocking.answer).not.toHaveBeenCalled()
    expect(blocking.cancel).not.toHaveBeenCalled()
    expect(resolved).not.toHaveBeenCalled()
  })

  it('dismisses locally without Escape, input writes or draft changes', async () => {
    await mount()
    await press('Dismiss')
    expect(composer).toBe('Existing draft')
    expect(renderer!.toJSON()).toBeNull()
    expect(blocking.cancel).not.toHaveBeenCalled()
    expect(resolved).not.toHaveBeenCalled()
  })

  it('refuses incomplete answers and answers for another prompt', async () => {
    await mount()
    expect(await actions.answer(prompt, [{ indices: [1] }])).toBe(false)
    expect(
      await actions.answer({ ...prompt, asyncCallIds: ['older'] }, [
        { indices: [1] },
        { indices: [], other: 'None' }
      ])
    ).toBe(false)
    expect(composer).toBe('Existing draft')
    expect(blocking.answer).not.toHaveBeenCalled()
  })

  it('preserves blocking answer and cancellation delivery', async () => {
    const blockingPrompt = { questions: [prompt.questions[0]] }
    await mount(blockingPrompt)
    expect(await actions.answer(blockingPrompt, [{ indices: [1] }])).toBe(true)
    expect(blocking.answer).toHaveBeenCalledWith(blockingPrompt, [{ indices: [1] }])
    expect(await actions.cancel()).toBe(true)
    expect(blocking.cancel).toHaveBeenCalledOnce()
    expect(resolved).toHaveBeenCalledTimes(2)
    expect(composer).toBe('Existing draft')
  })

  it('refuses a retained callback after a session switch even when the prompt content matches', async () => {
    await mount()
    const oldAnswer = actions.answer
    await act(async () =>
      renderer!.update(createElement(Harness, { session: 'different-session' }))
    )
    expect(await oldAnswer(prompt, [{ indices: [1] }, { indices: [], other: 'None' }])).toBe(false)
    expect(composer).toBe('Existing draft')
    expect(blocking.answer).not.toHaveBeenCalled()
  })
})
