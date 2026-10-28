import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import type { NativeChatResolvedPrompt } from '../../../../../src/shared/native-chat-resolution-receipt'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): unknown =>
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
  AlertCircle: 'AlertCircle',
  AlertTriangle: 'AlertTriangle',
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
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { findAllByHostType } from '../../../test-support/react-test-renderer-host-nodes'

describe('MobileNativeChatMessage', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(
    message: NativeChatMessage,
    props: {
      fontScale?: number
      structuredActivityUi?: boolean
      activeTurnIsWorking?: boolean
      trailingRun?: boolean
      foldedAway?: boolean
      turnExpanded?: boolean
      turnStatus?: {
        startedAt: number | null
        thinking: boolean
        workedSeconds: number | null
      } | null
      onToggleTurn?: () => void
      reasoningIsLive?: boolean
      unsentNotice?: string
      receipt?: NativeChatResolvedPrompt
      userMessageOpen?: boolean
      onToggleUserMessage?: (messageId: string) => void
      awaiting?: boolean
    } = {}
  ): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message, ...props }))
    })
    return renderer!
  }

  const textIn = (node: ReactTestInstance): string[] =>
    findAllByHostType(node, 'Text').map((text) => String(text.children.join('')))

  describe('a reasoning row', () => {
    const reasoning = (fields: Partial<NativeChatMessage> = {}): NativeChatMessage => ({
      id: 'r1',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Weighing two approaches' }],
      timestamp: 1_000,
      source: 'transcript',
      state: 'completed',
      completedAt: 4_000,
      ...fields
    })
    const toggleOf = (tree: ReactTestRenderer): ReactTestInstance =>
      tree.root.find(
        (node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'button'
      )
    const markdownIn = (tree: ReactTestRenderer): ReactTestInstance[] =>
      tree.root.findAll((node) => String(node.type) === 'MobileMarkdown')

    it('starts collapsed to its headline, with its text unmounted', () => {
      const tree = render(reasoning())
      expect(textIn(tree.root)).toContain('Thought for 3s')
      expect(toggleOf(tree).props.accessibilityState).toEqual({ expanded: false })
      expect(toggleOf(tree).props.accessibilityLabel).toBe('Reasoning: Thought for 3s')
      expect(toggleOf(tree).props.hitSlop).toBe(6)
      expect(markdownIn(tree)).toHaveLength(0)
    })

    it('leads its headline with the brain, as desktop does', () => {
      const [first] = toggleOf(render(reasoning())).children
      expect(typeof first === 'string' ? first : first?.type).toBe('Brain')
    })

    it('mounts its text once opened', () => {
      const tree = render(reasoning())
      act(() => toggleOf(tree).props.onPress())
      expect(toggleOf(tree).props.accessibilityState).toEqual({ expanded: true })
      expect(markdownIn(tree).map((node) => node.props.content)).toEqual([
        'Weighing two approaches'
      ])
    })

    it('draws nothing while the live line discloses it, or when blank', () => {
      expect(
        render(reasoning({ state: 'running' }), {
          activeTurnIsWorking: true,
          reasoningIsLive: true
        }).toJSON()
      ).toBeNull()
      expect(render(reasoning({ blocks: [{ type: 'text', text: ' \n ' }] })).toJSON()).toBeNull()
    })

    it("still draws its turn's bar while the live line discloses it", () => {
      const tree = render(reasoning({ state: 'running' }), {
        activeTurnIsWorking: true,
        reasoningIsLive: true,
        turnStatus: { startedAt: 1_000, thinking: true, workedSeconds: null }
      })
      expect(tree.root.findAll((node) => String(node.type) === 'Pressable')).toHaveLength(0)
      expect(textIn(tree.root).some((text) => text.startsWith('Working for'))).toBe(true)
    })

    it('draws any other open block in its working turn as Reasoning', () => {
      const child = render(reasoning({ state: 'running', agentId: 'sub-1' }), {
        activeTurnIsWorking: true
      })
      expect(textIn(child.root)).toContain('Reasoning')
      expect(toggleOf(child).props.accessibilityLabel).toBe('Reasoning')
    })

    it('says only what the host saw', () => {
      expect(textIn(render(reasoning({ state: 'running' })).root)).toContain('Thought')
      const unknown = render(reasoning({ state: undefined, completedAt: undefined }))
      expect(textIn(unknown.root)).toContain('Reasoning')
      expect(toggleOf(unknown).props.accessibilityLabel).toBe('Reasoning')
      expect(textIn(render(reasoning({ completedAt: 1_300 })).root)).toContain('Thought for 1s')
    })
  })
})
