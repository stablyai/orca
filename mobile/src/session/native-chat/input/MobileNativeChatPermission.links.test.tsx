import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileNativeChatOpenFileContext } from '../mobile-native-chat-open-file-context'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'

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
  ChevronDown: 'ChevronDown',
  ShieldQuestion: 'ShieldQuestion',
  X: 'X'
}))
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

// A terminal-backed plan review reaches the phone as a permission with a plan subject.
it('opens a file named in a plan approval through the chat', () => {
  const openFile = vi.fn()
  act(() => {
    renderer = create(
      createElement(
        MobileNativeChatOpenFileContext,
        { value: openFile },
        createElement(MobileNativeChatPermission, {
          permission: {
            title: 'Review proposed plan',
            subject: { kind: 'plan', text: 'First edit src/app.ts, then run tests.' },
            options: [{ label: 'Approve', send: 'approve' }]
          },
          onRespond: async () => true
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
})
