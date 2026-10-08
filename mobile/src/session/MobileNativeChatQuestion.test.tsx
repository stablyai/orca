import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  CircleHelp: 'CircleHelp',
  X: 'X'
}))

describe('MobileNativeChatQuestion', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('submits the selected duplicate-label row by position', async () => {
    const onAnswer = vi.fn(async () => true)

    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatQuestion, {
          question: {
            question: 'Pick regions',
            options: ['Region', 'Region'],
            multiSelect: true,
            allowOther: false,
            optionTokens: ['first-token', 'second-token']
          },
          onAnswer
        })
      )
    })

    const choices = renderer.root.findAllByProps({ accessibilityRole: 'checkbox' })
    await act(async () => choices[1]!.props.onPress())
    const submit = renderer.root.findByProps({ accessibilityLabel: 'Submit selected options' })
    await act(async () => submit.props.onPress())

    expect(onAnswer).toHaveBeenCalledWith('second-token')
  })

  it('submits a tokenless duplicate-label row by position', async () => {
    const onAnswer = vi.fn(async () => true)

    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatQuestion, {
          question: {
            question: 'Pick one',
            options: ['Choice', 'Choice'],
            multiSelect: false,
            allowOther: false,
            optionTokens: ['first-token', null]
          },
          onAnswer
        })
      )
    })

    const choices = renderer.root.findAllByProps({ accessibilityRole: 'button' })
    await act(async () => choices[1]!.props.onPress())

    expect(onAnswer).toHaveBeenCalledWith('Choice')
  })

  it('submits structured multi-select choices together with other text', async () => {
    const onAnswer = vi.fn(async () => true)

    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatQuestion, {
          question: {
            question: 'Pick regions',
            options: ['us-east', 'eu-west'],
            multiSelect: true,
            allowOther: true,
            optionTokens: ['east-token', 'west-token'],
            freeTextToken: 'other-token'
          },
          onAnswer
        })
      )
    })

    const choices = renderer.root.findAllByProps({ accessibilityRole: 'checkbox' })
    await act(async () => choices[0]!.props.onPress())
    const input = renderer.root.findByType('TextInput')
    await act(async () => input.props.onChangeText('ap-south'))
    const submit = renderer.root.findByProps({ accessibilityLabel: 'Submit selected options' })
    await act(async () => submit.props.onPress())

    expect(onAnswer).toHaveBeenCalledWith('east-token, other-token:ap-south')
  })

  it('passes the rendered prompt identity to cancel', async () => {
    const onCancel = vi.fn(async () => true)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatQuestion, {
          question: {
            question: 'Pick one',
            prompt: { itemId: 'question-1', expectedRevision: 7 },
            options: ['Choice'],
            multiSelect: false,
            allowOther: false,
            optionTokens: ['choice-token']
          },
          onAnswer: vi.fn(async () => true),
          onCancel
        })
      )
    })
    const cancel = renderer.root.findByProps({ accessibilityLabel: 'Cancel' })
    await act(async () => cancel.props.onPress())
    expect(onCancel).toHaveBeenCalledWith({ itemId: 'question-1', expectedRevision: 7 })
  })

  it('prefills an editor and sends its whitespace unchanged', async () => {
    const onAnswer = vi.fn(async () => true)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatQuestion, {
          question: {
            question: 'Edit the draft',
            options: [],
            multiSelect: false,
            optionTokens: [],
            freeTextToken: 'editor-token',
            freeTextInput: {
              allowEmpty: true,
              multiline: true,
              initialValue: '  draft\n',
              placeholder: 'Write here'
            }
          },
          onAnswer
        })
      )
    })

    const input = renderer.root.findByType('TextInput')
    expect(input.props).toMatchObject({
      value: '  draft\n',
      placeholder: 'Write here',
      multiline: true
    })
    await act(async () => input.props.onChangeText('  \n '))
    const send = renderer.root.findByProps({ accessibilityLabel: 'Send reply' })
    expect(send.props.disabled).toBe(false)
    await act(async () => send.props.onPress())
    expect(onAnswer).toHaveBeenCalledWith(`editor-token:${encodeURIComponent('  \n ')}`)
  })

  it('sends an empty allowed answer and still disables an empty legacy answer', async () => {
    const onAnswer = vi.fn(async () => true)
    const question = {
      question: 'Input',
      options: [],
      multiSelect: false,
      optionTokens: [],
      freeTextToken: 'input-token'
    }
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatQuestion, {
          question: { ...question, freeTextInput: { allowEmpty: true, multiline: false } },
          onAnswer
        })
      )
    })
    const send = renderer.root.findByProps({ accessibilityLabel: 'Send reply' })
    expect(renderer.root.findByType('TextInput').props.multiline).toBe(false)
    expect(send.props.disabled).toBe(false)
    await act(async () => send.props.onPress())
    expect(onAnswer).toHaveBeenCalledWith('input-token:')

    await act(async () =>
      renderer.update(createElement(MobileNativeChatQuestion, { question, onAnswer }))
    )
    expect(renderer.root.findByProps({ accessibilityLabel: 'Send reply' }).props.disabled).toBe(
      true
    )
  })
})
