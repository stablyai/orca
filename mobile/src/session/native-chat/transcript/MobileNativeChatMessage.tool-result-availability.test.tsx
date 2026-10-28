import { createElement, Fragment, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../../src/shared/agent-session-journal-types'
import * as toolFold from '../../../../../src/shared/native-chat/tools/native-chat-tool-pairs'
import { projectStructuredItemsToNativeChat } from '../../../../../src/shared/structured-agent-session-projection'
import { foldMobileNativeChatMessages } from '../../mobile-native-chat-render-data'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

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

  function render(row: NativeChatMessage, openRun = true): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message: row }))
    })
    if (openRun) {
      press(
        renderer!.root.find(
          (node) =>
            String(node.type) === 'Pressable' && node.props.accessibilityLiveRegion === 'polite'
        )
      )
    }
    return renderer!
  }

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

  it('draws each orphan output as its own Result row under one Result header', () => {
    const raw = message(
      Array.from({ length: 8 }, (_, index) => ({
        type: 'tool-result' as const,
        callId: `missing-${index}`,
        output: `preview ${index}\ncomplete output ${index}`
      }))
    )
    const [row] = foldMobileNativeChatMessages([raw], 'claude')
    expect(row?.role).toBe('tool')
    expect(foldMobileNativeChatMessages([row!], 'claude')).toEqual([row])
    const tree = render(row!)
    expect(textIn(tree.root).filter((text) => text === 'Result')).toHaveLength(9)
    expect(toolLines(tree.root)).toHaveLength(8)
    expect(textIn(tree.root)).not.toContain('preview 6\ncomplete output 6')

    press(button(tree.root, 'preview 6'))
    expect(textIn(tree.root)).toContain('preview 6\ncomplete output 6')
    expect(textIn(tree.root)).not.toContain('preview 7\ncomplete output 7')
  })

  it('gives a named completion to its own call past silent calls, not to the first', () => {
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
    const [row] = foldMobileNativeChatMessages([raw], 'claude')
    const tree = render(row!)
    expect(toolLines(tree.root)).toHaveLength(18)
    expect(textIn(tree.root)).not.toContain('late named output')
    press(button(tree.root, 'command 17'))
    expect(textIn(tree.root)).toContain('late named output')
    press(button(tree.root, 'command 17'))
    expect(button(tree.root, 'command 0').props.disabled).toBe(true)
  })

  it('pairs nothing while its run is collapsed', () => {
    const blocks: NativeChatMessage['blocks'] = Array.from({ length: 2049 }, (_, index) => ({
      type: 'tool-call',
      callId: `call-${index}`,
      name: 'Bash',
      input: { command: `input ${index}` }
    }))
    const pairing = vi.spyOn(toolFold, 'pairToolBlocks')
    const tree = render(message(blocks), false)
    expect(toolLines(tree.root)).toHaveLength(0)
    expect(pairing).not.toHaveBeenCalled()
    press(button(tree.root, 'Ran 2049 commands'))
    expect(pairing).toHaveBeenCalled()
    expect(toolLines(tree.root)).toHaveLength(2049)
  })

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
        const rows = foldMobileNativeChatMessages(raw, 'claude')
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
              structuredActivityUi: true
            })
          )
        )
      }
      act(() => {
        renderer = create(createElement(Phone, { journal: items }))
      })
      const tree = renderer!
      const headers = () =>
        tree.root.findAll(
          (node) =>
            String(node.type) === 'Pressable' && node.props.accessibilityLiveRegion === 'polite'
        )
      for (let index = 0; index < headers().length; index += 1) {
        press(headers()[index]!)
      }
      for (let index = 0; index < toolLines(tree.root).length; index += 1) {
        press(toolLines(tree.root)[index]!)
      }
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
      expect(foldMobileNativeChatMessages(drawn, 'claude')).toEqual(drawn)
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
    act(() => tree.update(createElement(MobileNativeChatMessage, { message: updated })))
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
