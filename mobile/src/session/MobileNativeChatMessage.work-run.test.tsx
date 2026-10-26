import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { RpcClient } from '../transport/rpc-client'
import { MobileNativeChatItemSourceContext } from './mobile-native-chat-item-read'
import { useMobileNativeChatMessageDetail } from './use-mobile-native-chat-message-detail'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    Animated: {
      Text,
      Value: class {
        setValue(): void {}
      }
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
  Bot: 'Bot',
  Brain: 'Brain',
  Check: 'Check',
  ChevronRight: 'ChevronRight',
  Circle: 'Circle',
  CircleCheck: 'CircleCheck',
  CircleDot: 'CircleDot',
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
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('../components/inline-text-selection', () => ({ INLINE_TEXT_SELECTION: false }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

import { nativeChatReasoningDisclosureKey } from '../../../src/shared/native-chat-reasoning-row'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'

const thought: NativeChatMessage = {
  id: 'r1',
  role: 'reasoning',
  state: 'completed',
  completedAt: 2_000,
  blocks: [{ type: 'text', text: 'Which file holds the fold?' }],
  timestamp: 0,
  source: 'transcript'
}
const read: NativeChatMessage = {
  id: 'a1',
  role: 'assistant',
  blocks: [
    { type: 'tool-call', name: 'Read', input: { file_path: 'src/a.ts' }, state: 'completed' }
  ],
  timestamp: 0,
  source: 'transcript'
}
const command: NativeChatMessage = {
  id: 'a2',
  role: 'assistant',
  blocks: [
    { type: 'tool-call', name: 'Bash', input: { command: 'pnpm test' }, state: 'completed' }
  ],
  timestamp: 0,
  source: 'transcript'
}

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

const textIn = (node: ReactTestInstance): string[] =>
  node.findAll((child) => String(child.type) === 'Text').map((text) => text.children.join(''))

it('draws a run that opens on a thought as one header, the thought inside it', () => {
  act(() => {
    renderer = create(
      createElement(MobileNativeChatMessage, {
        message: thought,
        workRun: [thought, read, command],
        structuredActivityUi: true,
        activeTurnIsWorking: false
      })
    )
  })
  const tree = renderer!
  expect(textIn(tree.root)).toContain('Read 1 file and ran 1 command')
  expect(tree.root.findAll((node) => String(node.type) === 'Brain')).toHaveLength(0)
  act(() =>
    tree.root
      .find((node) => String(node.type) === 'Pressable' && node.props.accessibilityLiveRegion)
      .props.onPress()
  )
  expect(tree.root.findAll((node) => String(node.type) === 'Brain')).toHaveLength(1)
  expect(textIn(tree.root)).toEqual(expect.arrayContaining(['Read', 'a.ts', 'pnpm test']))
  expect(tree.root.findAll((node) => String(node.type) === 'MobileMarkdown')).toHaveLength(0)
})

it('draws nothing for a row a run absorbed', () => {
  act(() => {
    renderer = create(
      createElement(MobileNativeChatMessage, {
        message: command,
        joinsWorkRun: true,
        structuredActivityUi: true,
        activeTurnIsWorking: false
      })
    )
  })
  expect(renderer!.toJSON()).toBeNull()
})

it("opens a grouped thought's own actions on a long press, not the run's first row's", () => {
  const openActions = vi.fn()
  act(() => {
    renderer = create(
      createElement(
        MobileNativeChatRowOverlaysContext.Provider,
        { value: { openImage: vi.fn(), openActions } },
        createElement(MobileNativeChatMessage, {
          message: read,
          workRun: [read, thought, command],
          openReasoning: new Set([nativeChatReasoningDisclosureKey(thought.id)]),
          onToggleReasoning: vi.fn(),
          structuredActivityUi: true,
          activeTurnIsWorking: false
        })
      )
    )
  })
  const tree = renderer!
  act(() => {
    tree.root
      .find((node) => String(node.type) === 'Pressable' && node.props.accessibilityLiveRegion)
      .props.onPress()
  })
  act(() => {
    tree.root
      .findAll((node) => String(node.type) === 'Pressable' && node.props.onLongPress)
      .at(-1)!
      .props.onLongPress()
  })
  expect(openActions).toHaveBeenCalledWith(thought)
})

it('loads a shortened grouped thought from its own source between two tool rows', async () => {
  const fullText = 'x'.repeat(99_991) + 'FULL TAIL'
  const shortened: NativeChatMessage = {
    ...thought,
    shortened: true,
    blocks: [{ type: 'text', text: fullText.slice(0, 70_000) }]
  }
  const item: AgentJournalRenderItem = {
    itemId: thought.id,
    sequence: 1,
    revision: 2,
    observedAt: 2_000,
    body: {
      kind: 'message',
      role: 'reasoning',
      state: 'completed',
      completedAt: 2_000,
      blocks: [{ type: 'text', text: fullText }]
    }
  }
  const sendRequest = vi.fn(async () => ({ id: 'detail', ok: true as const, result: { item } }))
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 0,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const source = { client, sessionId: 'session' }
  const messages = [read, shortened, command]
  function Transcript() {
    const detail = useMobileNativeChatMessageDetail(messages, source)
    return createElement(
      MobileNativeChatItemSourceContext.Provider,
      { value: { ...source, messageDetail: detail.detail } },
      createElement(MobileNativeChatMessage, {
        message: read,
        workRun: detail.messages,
        openReasoning: new Set([nativeChatReasoningDisclosureKey(thought.id)]),
        onToggleReasoning: vi.fn(),
        structuredActivityUi: true,
        activeTurnIsWorking: false
      })
    )
  }
  await act(async () => {
    renderer = create(createElement(Transcript))
  })
  const tree = renderer!
  act(() =>
    tree.root
      .find((node) => String(node.type) === 'Pressable' && node.props.accessibilityLiveRegion)
      .props.onPress()
  )
  expect(textIn(tree.root)).toContain('Read 1 file and ran 1 command')
  const showFull = tree.root.find(
    (node) =>
      String(node.type) === 'Pressable' &&
      node.props.accessibilityRole === 'button' &&
      textIn(node).includes('Show full message')
  )
  await act(async () => {
    showFull.props.onPress()
  })
  expect(sendRequest).toHaveBeenCalledExactlyOnceWith(
    'agentSession.item',
    { sessionId: source.sessionId, itemId: thought.id },
    expect.any(Object)
  )
  const markdown = tree.root.find((node) => String(node.type) === 'MobileMarkdown')
  expect(markdown.props.content).toBe(fullText)
  expect(textIn(tree.root)).not.toContain('Show full message')
  expect(textIn(tree.root)).toEqual(expect.arrayContaining(['Read', 'a.ts', 'pnpm test']))
})
