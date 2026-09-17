import { createElement } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ Check: 'Check' }))

function pressRowWithText(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const text = renderer.root.findAllByType('Text').find((node) => node.props.children === label)
  let node = text
  while (node && node.type !== 'Pressable') {
    node = node.parent
  }
  if (!node) {
    throw new Error(`no pressable row for ${label}`)
  }
  return node
}

describe('MobileNativeChatAsk', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('skips a single unanswered question through the skip seam, never an answer or cancel', async () => {
    const prompt = {
      questions: [{ question: 'q1', options: [{ label: 'A' }, { label: 'B' }] }]
    }
    const onAnswer = vi.fn(async () => true)
    const onSkip = vi.fn(async () => true)
    const onCancel = vi.fn(async () => true)
    await act(async () => {
      renderer = create(createElement(MobileNativeChatAsk, { prompt, onAnswer, onSkip, onCancel }))
    })

    await act(async () =>
      renderer.root.findByProps({ accessibilityLabel: 'Skip question' }).props.onPress()
    )

    expect(onSkip).toHaveBeenCalledWith(prompt)
    expect(onAnswer).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('disables the final Skip without a skip seam, leaving Cancel as the only dismissal', async () => {
    const onAnswer = vi.fn(async () => true)
    const onCancel = vi.fn(async () => true)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatAsk, {
          prompt: { questions: [{ question: 'q1', options: [{ label: 'A' }] }] },
          onAnswer,
          onCancel
        })
      )
    })

    const skip = renderer.root.findByProps({ accessibilityLabel: 'Skip question' })
    expect(skip.props.disabled).toBe(true)
    await act(async () => skip.props.onPress())
    expect(onAnswer).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('steps past an unanswered question then submits the answered one', async () => {
    const onAnswer = vi.fn(async () => true)
    const onSkip = vi.fn(async () => true)
    const onCancel = vi.fn(async () => true)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatAsk, {
          prompt: {
            questions: [
              { question: 'q1', options: [{ label: 'A' }] },
              { question: 'q2', options: [{ label: 'B' }, { label: 'C' }] }
            ]
          },
          onAnswer,
          onSkip,
          onCancel
        })
      )
    })

    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Skip question' }).props.children
    ).toBeTruthy()
    await act(async () =>
      renderer.root.findByProps({ accessibilityLabel: 'Skip question' }).props.onPress()
    )

    await act(async () => pressRowWithText(renderer, 'B').props.onPress())
    const submit = renderer.root.findByProps({ accessibilityLabel: 'Submit answer' })
    await act(async () => submit.props.onPress())

    expect(onSkip).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [] }, { indices: [0] }])
  })
})
