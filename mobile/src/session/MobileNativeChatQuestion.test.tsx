import { createElement } from 'react'
import { TextInput } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const QUESTION = {
  question: 'Choose one',
  options: ['Allow', 'Deny'],
  multiSelect: false,
  optionTokens: [null, null]
}

describe('MobileNativeChatQuestion', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('does not render a dead free-text control when the prompt disallows it', () => {
    act(() => {
      renderer = create(
        createElement(MobileNativeChatQuestion, {
          question: QUESTION,
          allowFreeText: false,
          onAnswer: vi.fn(async () => true)
        })
      )
    })

    expect(renderer!.root.findAllByType(TextInput)).toHaveLength(0)
  })
})
