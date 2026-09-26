import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'
import type { MobileChatQuestion } from './mobile-native-chat-question'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Check: 'Check',
  CircleHelp: 'CircleHelp',
  X: 'X'
}))

const question: MobileChatQuestion = {
  question: 'Which database?',
  options: ['PostgreSQL', 'MySQL', 'SQLite', 'DuckDB'],
  optionTokens: ['1', '2', '3', '4'],
  multiSelect: false
}

describe('MobileNativeChatQuestion card', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('scrolls long option lists inside a bounded region and keeps the reply row outside it', async () => {
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatQuestion, {
          question,
          onAnswer: vi.fn(async () => true)
        })
      )
    })

    const options = renderer.root.findByProps({ testID: 'native-chat-question-options' })
    const reply = renderer.root.findByProps({ testID: 'native-chat-question-reply' })

    expect(options.type).toBe('ScrollView')
    expect(options.props.style).toMatchObject({ maxHeight: 240, minHeight: 0, flexShrink: 1 })
    expect(options.findAllByProps({ children: 'DuckDB' })).toHaveLength(1)
    expect(options.findAllByType('TextInput')).toHaveLength(0)
    expect(reply.findAllByType('TextInput')).toHaveLength(1)
  })
})
