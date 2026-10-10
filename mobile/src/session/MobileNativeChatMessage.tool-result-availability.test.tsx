import { createElement, Fragment, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../src/shared/agent-session-journal-types'
import * as toolFold from '../../../src/shared/native-chat-tool-fold'
import { projectStructuredItemsToNativeChat } from '../../../src/shared/structured-agent-session-projection'
import { foldMobileNativeChatMessages } from './mobile-native-chat-render-data'
import { styles } from './mobile-native-chat-message-styles'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
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
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Brain: 'Brain',
  ChevronDown: 'ChevronDown',
  Copy: 'Copy',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench',
  ChevronRight: 'ChevronRight'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'

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
  return root.findAll(
    (node) =>
      String(node.type) === 'Pressable' &&
      node.findAll(
        (child) => String(child.type) === 'Text' && child.props.style === styles.toolName
      ).length > 0
  )
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

  function render(row: NativeChatMessage, turnExpanded = true): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message: row, turnExpanded }))
    })
    return renderer!
  }

  it('counts every orphan and lets the reader reveal the seventh output and hide it again', () => {
    const raw = message(
      Array.from({ length: 8 }, (_, index) => ({
        type: 'tool-result' as const,
        callId: `missing-${index}`,
        output: `preview ${index}\ncomplete output ${index}`
      }))
    )
    const [row] = foldMobileNativeChatMessages([raw])
    expect(row?.role).toBe('tool')
    expect(foldMobileNativeChatMessages([row!])).toEqual([row])
    const tree = render(row!)
    expect(textIn(tree.root)).toContain('8×')
    expect(
      tree.root.find(
        (node) => String(node.type) === 'Text' && node.props.style === styles.toolRunLabel
      ).props.children
    ).toBe('Result')
    expect(toolLines(tree.root)).toHaveLength(6)
    expect(textIn(tree.root)).not.toContain('preview 6')

    press(button(tree.root, 'Show more'))
    expect(toolLines(tree.root)).toHaveLength(8)
    press(button(tree.root, 'preview 6'))
    expect(textIn(tree.root)).toContain('preview 6\ncomplete output 6')
    expect(textIn(tree.root)).not.toContain('preview 7\ncomplete output 7')

    press(button(tree.root, 'Show less'))
    expect(toolLines(tree.root)).toHaveLength(6)
    expect(textIn(tree.root)).not.toContain('preview 6\ncomplete output 6')
  })

  it('reveals a named completion beyond silent calls without attaching it to the prefix', () => {
    const calls: NativeChatMessage['blocks'] = Array.from({ length: 18 }, (_, index) => ({
      type: 'tool-call',
      callId: `call-${index}`,
      name: 'Bash',
      input: { command: `command ${index}` }
    }))
    const raw = message([
      ...calls,
      { type: 'tool-result', callId: 'call-17', output: 'late named output' }
    ])
    const [row] = foldMobileNativeChatMessages([raw])
    const pairs = toolFold.pairToolBlocks(row!.blocks)
    expect(pairs.slice(0, 17).every((pair) => pair.result === undefined)).toBe(true)
    expect(pairs[17]?.result?.output).toBe('late named output')
    const tree = render(row!)
    expect(toolLines(tree.root)).toHaveLength(6)
    expect(textIn(tree.root)).not.toContain('late named output')

    press(button(tree.root, 'Show more'))
    expect(toolLines(tree.root)).toHaveLength(12)
    press(button(tree.root, 'Show more'))
    expect(toolLines(tree.root)).toHaveLength(18)
    press(button(tree.root, 'command 17'))
    expect(textIn(tree.root)).toContain('late named output')
    expect(textIn(tree.root)).not.toContain('command 0\nlate named output')
  })

  it.each(['calls', 'results'] as const)(
    'retains only the requested prefix and one reveal sentinel for 2,049 %s',
    (kind) => {
      const blocks: NativeChatMessage['blocks'] = Array.from({ length: 2049 }, (_, index) =>
        kind === 'calls'
          ? { type: 'tool-call', callId: `call-${index}`, name: 'Bash', input: `input ${index}` }
          : { type: 'tool-result', callId: `missing-${index}`, output: `output ${index}` }
      )
      const pairing = vi.spyOn(toolFold, 'pairToolBlocks')
      const tree = render(message(blocks), false)
      expect(toolLines(tree.root)).toHaveLength(0)
      expect(pairing).not.toHaveBeenCalled()
      press(button(tree.root, '2049×'))
      expect(toolLines(tree.root)).toHaveLength(6)
      expect(pairing).toHaveBeenCalledTimes(1)
      expect(pairing).toHaveBeenLastCalledWith(blocks, 7)
      expect(pairing.mock.results[0]?.value).toHaveLength(7)
      expect(textIn(tree.root)).toContain('2049×')
      expect(button(tree.root, 'Show more').props.accessibilityRole).toBe('button')
      press(button(tree.root, 'Show more'))
      expect(pairing).toHaveBeenLastCalledWith(blocks, 13)
      expect(pairing.mock.results[1]?.value).toHaveLength(13)
      expect(toolLines(tree.root)).toHaveLength(12)
    }
  )

  it.each([true, false])(
    'draws derived outputs ahead of a prompt queued while stopping (host scopes: %s)',
    (hasScopes) => {
      function item(
        itemId: string,
        sequence: number,
        body: AgentJournalItemBody
      ): AgentJournalRenderItem {
        return {
          itemId,
          sequence,
          body,
          revision: 1,
          observedAt: sequence,
          ...(hasScopes
            ? {
                turnScope:
                  sequence <= 2
                    ? { kind: 'thread' as const }
                    : { kind: 'turn' as const, turnItemId: 'turn' }
              }
            : {})
        }
      }
      const items = [
        item('prompt', 1, {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'question' }]
        }),
        item('turn', 2, { kind: 'turn', turnId: 'turn', userItemId: 'prompt', state: 'running' }),
        item('working-call', 3, {
          kind: 'tool-call',
          callId: 'working',
          name: 'Bash',
          input: 'still working',
          state: 'running'
        }),
        item('queued', 4, {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'queued question' }]
        }),
        item('source', 5, {
          kind: 'message',
          role: 'assistant',
          blocks: [
            { type: 'text', text: 'source context' },
            { type: 'tool-result', callId: 'unavailable-a', output: 'output one\nfull one' },
            { type: 'tool-result', callId: 'unavailable-b', output: 'output two\nfull two' }
          ]
        })
      ]
      let drawn: NativeChatMessage[] = []
      let waiting: string[] = []
      let live: string[] = []
      function Phone({ journal }: { journal: AgentJournalRenderItem[] }): React.JSX.Element {
        const raw = projectStructuredItemsToNativeChat(journal).map((row) =>
          row.id === 'queued' ? { ...row, queued: true as const } : row
        )
        const rows = foldMobileNativeChatMessages(raw)
        const disclosure = useMobileNativeChatTurnDisclosure({
          messages: rows,
          enabled: true,
          isWorking: true,
          stopping: true,
          turnJournal: { items: journal, submissions: [] },
          scopeKey: 'remote-host\0folder\0tab'
        })
        drawn = Array.from(disclosure.listMessages)
        waiting = disclosure.waitingRows.map((row) => row.item.id)
        live = drawn.flatMap((row, index) =>
          disclosure.resolveRow(index, row).activeTurnIsWorking ? [row.id] : []
        )
        return createElement(
          Fragment,
          null,
          ...drawn.map((row, index) =>
            createElement(MobileNativeChatMessage, {
              key: row.id,
              message: row,
              ...disclosure.resolveRow(index, row),
              structuredActivityUi: true,
              toolsExpanded: true
            })
          )
        )
      }
      act(() => {
        renderer = create(createElement(Phone, { journal: items }))
      })
      const tree = renderer!
      const orphan = drawn.find((row) => row.role === 'tool')!
      expect(orphan.id).not.toBe('source')
      expect(orphan.journalPosition).toEqual({ sequence: 5, index: 0 })
      expect(drawn.map((row) => row.id)).toEqual(['prompt', 'working-call', 'source', orphan.id])
      expect(waiting).toEqual(['queued'])
      expect(live).toContain(orphan.id)
      expect(toolLines(tree.root)).toHaveLength(3)
      expect(textIn(tree.root)).toContain('output one\nfull one')
      expect(textIn(tree.root)).toContain('output two\nfull two')
      const firstOutput = button(tree.root, 'output one')
      act(() => tree.update(createElement(Phone, { journal: structuredClone(items) })))
      expect(drawn.find((row) => row.role === 'tool')?.id).toBe(orphan.id)
      expect(waiting).toEqual(['queued'])
      expect(button(tree.root, 'output one')).toBe(firstOutput)
      expect(foldMobileNativeChatMessages(drawn)).toEqual(drawn)
    }
  )

  it('keeps duplicate-ID rows independently open as results and later rows arrive', () => {
    const initial = message([
      { type: 'tool-call', callId: 'duplicate', name: 'Bash', input: 'first input' },
      { type: 'tool-call', callId: 'duplicate', name: 'Bash', input: 'second input' },
      { type: 'tool-result', callId: 'duplicate', output: 'first output' }
    ])
    const tree = render(initial)
    const first = button(tree.root, 'first input')
    const second = button(tree.root, 'second input')
    press(first)
    expect(textIn(tree.root)).toContain('first output')
    const updated = message([
      { type: 'tool-call', callId: 'duplicate', name: 'Bash', input: 'changed first input' },
      { type: 'tool-call', callId: 'duplicate', name: 'Bash', input: 'changed second input' },
      { type: 'tool-result', callId: 'duplicate', output: 'first output' },
      { type: 'tool-result', callId: 'duplicate', output: 'second output' },
      { type: 'tool-call', callId: 'later', name: 'Bash', input: 'later input' }
    ])
    act(() =>
      tree.update(createElement(MobileNativeChatMessage, { message: updated, turnExpanded: true }))
    )
    expect(button(tree.root, 'changed first input')).toBe(first)
    expect(button(tree.root, 'changed second input')).toBe(second)
    expect(textIn(tree.root)).toContain('first output')
    expect(textIn(tree.root)).not.toContain('second output')
    press(second)
    expect(textIn(tree.root)).toContain('second output')
    press(first)
    expect(textIn(tree.root)).not.toContain('first output')
    expect(textIn(tree.root)).toContain('second output')
  })
})
