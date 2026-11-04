import type { ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../../../src/shared/native-chat/native-chat-types'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    Image: 'Image',
    Platform: { OS: 'ios', select: (specifics: { ios?: unknown }) => specifics.ios },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Animated: { Value: class {}, timing: () => ({ start: vi.fn() }) }
  }
})
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  Easing: { bezier: () => (t: number) => t },
  useReducedMotion: () => false,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withTiming: (to: unknown) => to
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  Bot: 'Bot',
  Brain: 'Brain',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
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
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('../../../hooks/use-now', () => ({ useNow: () => 70_000 }))

import { MobileNativeChatOpenSubagentProvider } from '../input/mobile-native-chat-open-subagent'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'

function roster(agents: NativeChatSubagentEntry[]): NativeChatMessage {
  return {
    id: 'spawn',
    role: 'system',
    blocks: [
      { type: 'text', text: 'Ran 1 subagent' },
      { type: 'subagent-group', groupId: 'group-1', agents }
    ],
    timestamp: null,
    source: 'transcript'
  }
}

function byTestId(node: ReactTestInstance, testID: string): boolean {
  return typeof node.type === 'string' && node.props.testID === testID
}

describe('opening a roster child', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('opens a roster child from its row when the transcript can show it', () => {
    const onOpen = vi.fn<(agentId: string | null) => void>()
    act(() => {
      renderer = create(
        <MobileNativeChatOpenSubagentProvider onOpen={onOpen}>
          <MobileNativeChatMessage
            message={roster([{ id: 'child-1', label: 'sample_greeting', state: 'completed' }])}
            subagentGroupsOpen={new Set(['group-1'])}
          />
        </MobileNativeChatOpenSubagentProvider>
      )
    })
    const entry = renderer!.root.findAll((node) => byTestId(node, 'native-chat-open-subagent'))
    expect(entry).toHaveLength(1)
    expect(entry[0]?.props.accessibilityLabel).toBe('Open sample_greeting')
    act(() => entry[0]?.props.onPress())
    expect(onOpen).toHaveBeenCalledWith('child-1')
  })
})
