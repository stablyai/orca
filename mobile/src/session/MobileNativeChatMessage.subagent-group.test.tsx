// A spawn group's roster row on the phone: drawn from the host's live block, replacing its frozen
// sentence only when it can draw, outside the settled-tools collapse, and opened by group id from
// state the transcript holds.

import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../src/shared/native-chat-types'
import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    Image: 'Image',
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Animated: { Value: class {}, timing: () => ({ start: vi.fn() }) }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  Bot: 'Bot',
  Brain: 'Brain',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('../hooks/use-now', () => ({ useNow: () => 70_000 }))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'

function roster(
  agents: NativeChatSubagentEntry[],
  sentence: string | null = 'Kicked off 2 subagents'
): NativeChatMessage {
  return {
    id: 'spawn',
    role: 'system',
    blocks: [
      ...(sentence === null ? [] : [{ type: 'text' as const, text: sentence }]),
      { type: 'subagent-group', groupId: 'group-1', agents }
    ],
    timestamp: null,
    source: 'transcript'
  }
}

const WORKING: NativeChatSubagentEntry[] = [
  { id: 'a', label: 'review', state: 'working', startedAt: 10_000 },
  { id: 'b', label: 'tests', state: 'working', startedAt: 10_000 }
]
const FINISHED: NativeChatSubagentEntry[] = [
  { id: 'a', label: 'review', state: 'completed', startedAt: 0, settledAt: 60_000, tokens: 9_000 },
  { id: 'b', label: 'tests', state: 'failed', startedAt: 0, settledAt: 62_000, tokens: 3_000 }
]

// The View mock is a component around a host node; match the host alone so nothing counts twice.
function byTestId(node: ReactTestInstance, testID: string): boolean {
  return typeof node.type === 'string' && node.props.testID === testID
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
}

describe('mobile transcript roster row', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(
    message: NativeChatMessage,
    props: Record<string, unknown> = {}
  ): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message, ...props }))
    })
    return renderer!
  }

  const markdown = (tree: ReactTestRenderer): unknown[] =>
    tree.root.findAll((node) => String(node.type) === 'MobileMarkdown').map((n) => n.props.content)
  const group = (tree: ReactTestRenderer): ReactTestInstance[] =>
    tree.root.findAll((node) => byTestId(node, 'subagent-group'))

  it("draws the host's live group in place of its frozen sentence", () => {
    const tree = render(roster(WORKING))
    expect(markdown(tree)).toEqual([])
    expect(group(tree)).toHaveLength(1)
    expect(textOf(group(tree)[0]!)).toBe('Kicked off 2 subagents2 working · 1m 0s')
  })

  it('reads the settled verdict, run length and tokens', () => {
    const tree = render(roster(FINISHED, 'Ran 2 subagents (1 failed)'))
    expect(markdown(tree)).toEqual([])
    expect(textOf(group(tree)[0]!)).toBe('Ran 2 subagents1 failed · 1m 2s · 12k tokens')
  })

  it('speaks the header whole, its clock only once the group stops counting', () => {
    const label = (tree: ReactTestRenderer): unknown =>
      group(tree)[0]!.findAll((node) => String(node.type) === 'Pressable')[0]!.props
        .accessibilityLabel
    expect(label(render(roster(WORKING)))).toBe('Kicked off 2 subagents · 2 working')
    const alerted: NativeChatSubagentEntry[] = [
      ...WORKING,
      { id: 'c', label: 'lint', state: 'failed', startedAt: 0, settledAt: 5_000 }
    ]
    expect(label(render(roster(alerted)))).toBe('Kicked off 3 subagents · 2 working +1 failed')
    expect(label(render(roster(FINISHED)))).toBe('Ran 2 subagents · 1 failed · 1m 2s · 12k tokens')
  })

  it('keeps the sentence when there is no group it can draw', () => {
    const textOnly: NativeChatMessage = {
      id: 'spawn',
      role: 'system',
      blocks: [{ type: 'text', text: 'Ran 2 subagents' }],
      timestamp: null,
      source: 'transcript'
    }
    expect(markdown(render(textOnly))).toEqual(['Ran 2 subagents'])
    const childless = render(roster([], 'Ran 2 subagents'))
    expect(markdown(childless)).toEqual(['Ran 2 subagents'])
    expect(group(childless)).toEqual([])
  })

  it('keeps real text beside a group', () => {
    expect(markdown(render(roster(WORKING, 'Delegating the review.')))).toEqual([
      'Delegating the review.'
    ])
  })

  it('stays visible once its turn settles, outside the tool-run collapse', () => {
    const tree = render(roster(FINISHED, null), {
      structuredActivityUi: true,
      activeTurnIsWorking: false,
      turnExpanded: false
    })
    expect(group(tree)).toHaveLength(1)
  })

  it('lists each child when the transcript holds it open, and asks to toggle by group id', () => {
    const onToggleSubagentGroup = vi.fn()
    const closed = render(roster(FINISHED), { onToggleSubagentGroup })
    expect(closed.root.findAll((node) => byTestId(node, 'subagent-group-entry'))).toEqual([])
    const header = group(closed)[0]!.findAll((node) => String(node.type) === 'Pressable')[0]!
    act(() => header.props.onPress())
    expect(onToggleSubagentGroup).toHaveBeenCalledWith('group-1')

    const open = render(roster(FINISHED), {
      subagentGroupsOpen: new Set(['group-1']),
      onToggleSubagentGroup
    })
    expect(open.root.findAll((node) => byTestId(node, 'subagent-group-entry')).map(textOf)).toEqual(
      ['reviewcompleted · 9k', 'testsfailed · 3k']
    )
  })
})

describe('transcript-held roster disclosure', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('opens a group by id and hands the open set to roster rows only', () => {
    const messages = [userMessage('ask'), roster(WORKING)]
    act(() => {
      renderer = create(createElement(Harness, { messages, enabled: true, isWorking: false }))
    })
    const disclosure = () => renderer!.root.findByType(Result).props.disclosure
    const rowFor = (index: number) => disclosure().resolveRow(index, messages[index]!)
    expect(rowFor(0).subagentGroupsOpen).toBeUndefined()
    expect(rowFor(1).subagentGroupsOpen?.has('group-1')).toBe(false)
    act(() => rowFor(1).onToggleSubagentGroup('group-1'))
    expect(rowFor(1).subagentGroupsOpen?.has('group-1')).toBe(true)
  })
})
