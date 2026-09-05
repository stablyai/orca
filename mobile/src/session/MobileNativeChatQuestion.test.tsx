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
  CircleHelp: 'CircleHelp'
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
})
