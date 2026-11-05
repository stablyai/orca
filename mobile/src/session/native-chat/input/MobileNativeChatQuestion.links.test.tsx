import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileNativeChatOpenFileContext } from '../mobile-native-chat-open-file-context'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'

vi.mock('react-native', () => ({
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  CircleHelp: 'CircleHelp',
  X: 'X'
}))
vi.mock('../../../components/composer-input/MessageBox', () => ({ MessageBox: 'MessageBox' }))
vi.mock('../../../components/pr-sidebar/MermaidDiagram', () => ({
  MermaidDiagram: 'MermaidDiagram'
}))
vi.mock('../../../components/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: 'MobileSourceCopyButton'
}))

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

const flatten = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(flatten).join('')
const flattenStyle = (style: unknown): Record<string, unknown> =>
  Array.isArray(style)
    ? Object.assign({}, ...style.map(flattenStyle))
    : style && typeof style === 'object'
      ? Object.fromEntries(Object.entries(style))
      : {}

// A terminal-backed question reaches the phone as plain agent text, which names files like any chat text.
it('opens a file named in a question card through the chat', () => {
  const openFile = vi.fn()
  act(() => {
    renderer = create(
      createElement(
        MobileNativeChatOpenFileContext,
        { value: openFile },
        createElement(MobileNativeChatQuestion, {
          question: {
            question: 'Should I keep the **retry** in src/app.ts?',
            options: ['Yes', 'No'],
            multiSelect: false,
            optionTokens: [null, null]
          },
          onAnswer: async () => true
        })
      )
    )
  })
  const link = renderer!.root.find(
    (node) =>
      String(node.type) === 'Text' &&
      typeof node.props.onPress === 'function' &&
      flatten(node) === 'src/app.ts'
  )
  act(() => link.props.onPress())
  expect(openFile).toHaveBeenCalledExactlyOnceWith('src/app.ts')
  // The title is already strong, so the agent's bold must still read heavier than it.
  const boldWeights = renderer!.root
    .findAll((node) => String(node.type) === 'Text' && flatten(node) === 'retry')
    .map((node) => flattenStyle(node.props.style).fontWeight)
  expect(boldWeights).toContain('700')
})
