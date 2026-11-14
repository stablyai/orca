import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      Text,
      Value: class {
        setValue(): void {}
      },
      loop: (animation: unknown) => animation,
      sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
      timing: () => ({ start: vi.fn(), stop: vi.fn() })
    },
    Image: 'Image',
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 400, height: 800 })
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Bot: 'Bot',
  Brain: 'Brain',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  Copy: 'Copy',
  Eye: 'Eye',
  FileMinus2: 'FileMinus2',
  FilePen: 'FilePen',
  FilePlus2: 'FilePlus2',
  Folder: 'Folder',
  Globe: 'Globe',
  ListChecks: 'ListChecks',
  MessageSquareMore: 'MessageSquareMore',
  Pencil: 'Pencil',
  Plug: 'Plug',
  Search: 'Search',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench'
}))
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('../../../components/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: 'CopyButton'
}))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import {
  MobileNativeChatDisclosureContext,
  useMobileNativeChatDisclosures
} from './mobile-native-chat-disclosure-store'

function message(blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id: 'source', role: 'assistant', blocks, timestamp: 1, source: 'transcript' }
}

function textIn(node: ReactTestInstance): string[] {
  return node
    .findAll((child) => String(child.type) === 'Text')
    .map((child) =>
      child.children
        .flatMap((part) =>
          typeof part === 'string' || typeof part === 'number' ? [String(part)] : []
        )
        .join('')
    )
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((node) => String(node.type) === 'Pressable' && textIn(node).includes(label))
}

function toolLines(root: ReactTestInstance): ReactTestInstance[] {
  return root
    .findAll((node) => String(node.type) === 'ScrollView')
    .flatMap((box) => box.findAll((node) => String(node.type) === 'Pressable'))
}

function press(node: ReactTestInstance): void {
  act(() => {
    node.props.onPress()
  })
}

describe('mobile tool result availability', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  // The page's window unmounts a row scrolled past; older messages joining its fold change its id.
  it('keeps what the reader opened in a windowed-out row by its row key', () => {
    const row = message([
      { type: 'tool-call', callId: 'one', name: 'Bash', input: 'first input' },
      { type: 'tool-result', callId: 'one', output: 'first output' },
      { type: 'tool-call', callId: 'two', name: 'Bash', input: 'second input' },
      { type: 'tool-result', callId: 'two', output: 'second output' }
    ])
    function Window({ shown, id }: { shown: boolean; id: string }) {
      const disclosures = useMobileNativeChatDisclosures('chat')
      return createElement(
        MobileNativeChatDisclosureContext.Provider,
        { value: disclosures },
        shown
          ? createElement(MobileNativeChatMessage, {
              message: { ...row, id },
              rowKey: 'kept'
            })
          : null
      )
    }
    const draw = (shown: boolean, id = 'source') =>
      act(() => {
        const element = createElement(Window, { shown, id })
        if (renderer) {
          renderer.update(element)
        } else {
          renderer = create(element)
        }
      })
    const header = () =>
      renderer!.root.find(
        (node) =>
          String(node.type) === 'Pressable' && node.props.accessibilityLiveRegion === 'polite'
      )
    draw(true)
    press(header())
    press(button(renderer!.root, 'first input'))
    draw(false)
    draw(true, 'older-head')
    expect(toolLines(renderer!.root)).toHaveLength(2)
    expect(textIn(renderer!.root)).toContain('first output')
    expect(textIn(renderer!.root)).not.toContain('second output')
  })
})
