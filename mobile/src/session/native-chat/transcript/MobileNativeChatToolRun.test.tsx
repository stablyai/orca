import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalToolCallItem } from '../../../../../src/shared/agent-session-journal-types'
import { MAX_TOOL_DETAIL_LENGTH } from '../../../../../src/shared/native-chat/tools/native-chat-tool-summary'
import { projectStructuredItemToNativeChat } from '../../../../../src/shared/structured-agent-session-projection'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatToolCallBlock
} from '../../../../../src/shared/native-chat-types'
import { colors } from '../../../theme/mobile-theme'

const scrolls = vi.hoisted(() => ({ toEnd: vi.fn(), to: vi.fn() }))

vi.mock('react-native', async () => {
  const React = await import('react')
  class ScrollView extends React.Component<{ children?: ReactNode }> {
    scrollToEnd = scrolls.toEnd
    scrollTo = scrolls.to
    render(): ReactNode {
      return React.createElement('ScrollView', this.props, this.props.children)
    }
  }
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    Animated: {
      Text,
      Value: class {
        setValue(): void {}
      },
      loop: (animation: unknown) => animation,
      sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
      timing: () => ({ start: vi.fn(), stop: vi.fn() })
    },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView,
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 400, height: 800 })
  }
})
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

vi.mock('../../../components/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: 'CopyButton'
}))
vi.mock('../../../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../../../components/inline-text-selection', () => ({ INLINE_TEXT_SELECTION: false }))

import { openExternalLink } from '../../../platform/external-link'
import { ToolRun } from './MobileNativeChatToolRun'
import {
  MobileNativeChatDisclosureContext,
  useMobileNativeChatDisclosures
} from '../../mobile-native-chat-disclosure-store'

describe('ToolRun', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(
    blocks: NativeChatBlock[] | NativeChatMessage,
    onOpenFile?: (path: string) => void
  ): ReactTestRenderer {
    act(() => {
      renderer = create(
        createElement(ToolRun, {
          blocks: Array.isArray(blocks) ? blocks : blocks.blocks,
          onOpenFile
        })
      )
    })
    openRun(renderer!)
    return renderer!
  }

  function openRun(tree: ReactTestRenderer): void {
    act(() => {
      tree.root.findAll((node) => String(node.type) === 'Pressable')[0]!.props.onPress()
    })
  }

  const textIn = (node: ReactTestInstance): string[] =>
    node
      .findAll((node) => String(node.type) === 'Text')
      .map((text) => String(text.children.join('')))

  describe('tool rows, as desktop draws them', () => {
    const pressable = (tree: ReactTestRenderer, label: string): ReactTestInstance =>
      tree.root
        .findAll((node) => String(node.type) === 'Pressable')
        .findLast((node) => textIn(node).some((text) => text.startsWith(label)))!
    const open = (tree: ReactTestRenderer, label: string): void => {
      act(() => {
        pressable(tree, label).props.onPress()
      })
    }
    const textNode = (tree: ReactTestRenderer, text: string): ReactTestInstance =>
      tree.root.findAll((node) => String(node.type) === 'Text' && textIn(node)[0] === text)[0]!
    const flatStyle = (node: ReactTestInstance): Record<string, unknown> =>
      Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean))

    it('names a read by its verb and file, not its input', () => {
      const tree = render([
        { type: 'tool-call', name: 'Read', input: { file_path: 'src/index.ts' } },
        { type: 'tool-result', output: 'contents' }
      ])
      expect(textIn(tree.root)).toEqual(expect.arrayContaining(['Read 1 file', 'Read', 'index.ts']))
      expect(textIn(tree.root).some((text) => text.includes('file_path'))).toBe(false)
    })

    it('opens a call to its output, plus the whole command only when the row shortened it', () => {
      const command = `pnpm vitest run ${'src/session/'.repeat(10)}`
      const tree = render([
        { type: 'tool-call', name: 'Bash', input: { command } },
        { type: 'tool-result', output: 'ok' },
        { type: 'tool-call', name: 'Bash', input: { command: 'ls', description: 'List' } },
        { type: 'tool-result', output: 'a.ts' }
      ])
      open(tree, 'ls')
      expect(textIn(tree.root)).toContain('a.ts')
      expect(textIn(tree.root).some((text) => text.includes('"description"'))).toBe(false)
      open(tree, 'pnpm vitest run')
      expect(textIn(tree.root)).toEqual(expect.arrayContaining([command, 'ok']))
    })

    it('bounds an opened output before native text layout', () => {
      const tree = render([
        { type: 'tool-call', name: 'Bash', input: { command: 'cat big.log' } },
        { type: 'tool-result', output: 'x'.repeat(100_000) }
      ])
      open(tree, 'cat big.log')
      const output = textIn(tree.root).find((text) => text.startsWith('xxx'))
      expect(output).toHaveLength(MAX_TOOL_DETAIL_LENGTH + 1)
      expect(output?.endsWith('…')).toBe(true)
    })

    it('draws command output that merely starts lines with - or + as plain text', () => {
      const listing = '-rw-r--r--  1 me  staff  12 a.ts\n-rw-r--r--  1 me  staff  14 b.ts'
      const tree = render([
        { type: 'tool-call', name: 'Bash', input: { command: 'ls -la' } },
        { type: 'tool-result', output: listing }
      ])
      open(tree, 'ls -la')
      expect(textIn(tree.root)).toContain(listing)
    })

    it('keeps a failed command red even when its output reads as a diff', () => {
      const output = 'error: patch failed\n-const a = 1\n+const a = 2'
      const tree = render([
        { type: 'tool-call', name: 'Bash', input: { command: 'git apply x.patch' } },
        { type: 'tool-result', output, isError: true }
      ])
      expect(textIn(tree.root)).toContain(' · 1 failed')
      open(tree, 'git apply x.patch')
      expect(flatStyle(textNode(tree, output)).color).toBe(colors.statusRed)
    })

    it('links only a read or edited file, and only by its name', () => {
      const onOpenFile = vi.fn()
      const tree = render(
        [
          { type: 'tool-call', name: 'Read', input: { file_path: 'src/a.ts' } },
          { type: 'tool-result', output: 'a' },
          { type: 'tool-call', name: 'list', input: { command: 'ls src', path: 'src' } },
          { type: 'tool-result', output: 'a.ts' }
        ],
        onOpenFile
      )
      act(() => textNode(tree, 'a.ts').props.onPress())
      expect(onOpenFile).toHaveBeenCalledWith('src/a.ts')
      expect(textIn(tree.root)).toEqual(expect.arrayContaining(['Listed', 'src']))
      expect(textNode(tree, 'src').props.onPress).toBeUndefined()
      open(tree, 'Read')
      expect(textIn(tree.root)).toContain('a')
      expect(onOpenFile).toHaveBeenCalledTimes(1)
    })

    it('offers no caret on a row with nothing to show', () => {
      const tree = render([{ type: 'tool-call', name: 'Agent', input: { description: 'Explore' } }])
      expect(textIn(tree.root)).toEqual(expect.arrayContaining(['Subagent', 'Explore']))
      expect(tree.root.findAll((node) => String(node.type) === 'ChevronRight')).toHaveLength(0)
      expect(pressable(tree, 'Subagent').props.disabled).toBe(true)
    })
  })

  describe('output a call left when it ended early', () => {
    function projectedCall(ending: Pick<AgentJournalToolCallItem, 'endedAs'>): NativeChatMessage {
      const body: AgentJournalToolCallItem = {
        kind: 'tool-call',
        name: 'shell',
        input: { command: 'sleep 20' },
        state: 'failed',
        ...ending,
        output: { head: 'partial', byteLength: 7, digest: 'd', truncated: false }
      }
      const projected = projectStructuredItemToNativeChat({
        itemId: 'call',
        sequence: 1,
        revision: 1,
        observedAt: 100,
        body
      })
      if (!projected) {
        throw new Error('the call projects no message')
      }
      return { ...projected, id: 'a1', source: 'transcript' }
    }
    const outputColor = (message: NativeChatMessage): unknown => {
      const tree = render(message)
      act(() =>
        tree.root
          .findAll((node) => String(node.type) === 'Pressable')
          .findLast((node) => textIn(node).includes('sleep 20'))!
          .props.onPress()
      )
      const output = tree.root
        .findAll((node) => String(node.type) === 'Text')
        .find((node) => node.children.join('') === 'partial')!
      return Object.assign({}, ...[output.props.style].flat(Infinity).filter(Boolean)).color
    }

    it('shows the output a stop cut short without the error colour', () => {
      expect(outputColor(projectedCall({ endedAs: 'interrupted' }))).not.toBe(colors.statusRed)
    })

    it('keeps the error colour on a call nothing proved was cut short', () => {
      expect(outputColor(projectedCall({ endedAs: 'unverifiable' }))).toBe(colors.statusRed)
    })
  })

  describe('edits and searches, as desktop draws them', () => {
    const openRow = (tree: ReactTestRenderer, label: string): void => {
      act(() => {
        tree.root
          .findAll((node) => String(node.type) === 'Pressable')
          .findLast((node) => textIn(node).includes(label))!
          .props.onPress()
      })
    }

    it('opens a rewrite to every removed and added line in unified order, with nothing cut', () => {
      const before = Array.from({ length: 15 }, (_, i) => `old ${i}`).join('\n')
      const after = Array.from({ length: 15 }, (_, i) => `new ${i}`).join('\n')
      const tree = render([
        {
          type: 'tool-call',
          name: 'Edit',
          input: { file_path: 'src/a.ts', old_string: before, new_string: after }
        },
        { type: 'tool-result', output: 'The file src/a.ts has been updated.' }
      ])
      expect(textIn(tree.root)).toEqual(expect.arrayContaining(['Edited', 'a.ts', '+15', '-15']))
      openRow(tree, 'a.ts')
      const rows = textIn(tree.root).filter((text) => /^(old|new) \d+$/.test(text))
      expect(rows).toEqual([...before.split('\n'), ...after.split('\n')])
      expect(textIn(tree.root).some((text) => text.includes('truncated'))).toBe(false)
      expect(textIn(tree.root)).not.toContain('The file src/a.ts has been updated.')
    })

    it.each([
      [
        'a MultiEdit',
        {
          type: 'tool-call',
          name: 'MultiEdit',
          input: {
            file_path: 'src/b.ts',
            edits: [{ old_string: 'let x = 1', new_string: 'let x = 2' }]
          }
        }
      ],
      [
        'a Codex patch',
        {
          type: 'tool-call',
          name: 'apply_patch',
          input:
            '*** Begin Patch\n*** Update File: src/b.ts\n@@\n-let x = 1\n+let x = 2\n*** End Patch'
        }
      ]
    ] as const)('draws %s as a diff card, not escaped text', (_name, call) => {
      const tree = render([
        { ...call, state: 'completed' },
        { type: 'tool-result', output: 'Success' }
      ])
      openRow(tree, 'b.ts')
      expect(textIn(tree.root)).toEqual(expect.arrayContaining(['let x = 1', 'let x = 2']))
      expect(
        textIn(tree.root).some((text) => text.includes('\\n') || text.includes('*** Begin'))
      ).toBe(false)
    })

    it('gives each file of a multi-file change its own card, and links no deleted file', () => {
      const onOpenFile = vi.fn()
      const tree = render(
        [
          {
            type: 'tool-call',
            name: 'apply_patch',
            input:
              '*** Begin Patch\n*** Update File: src/d.ts\n@@\n-d\n+e\n*** Delete File: src/gone.ts\n*** End Patch',
            state: 'completed'
          },
          { type: 'tool-result', output: 'Success' }
        ],
        onOpenFile
      )
      expect(textIn(tree.root)).toEqual(
        expect.arrayContaining(['Edited', 'd.ts', 'Deleted', 'gone.ts'])
      )
      const name = (text: string) =>
        tree.root.findAll((node) => String(node.type) === 'Text' && textIn(node)[0] === text)[0]!
      act(() => name('d.ts').props.onPress())
      expect(onOpenFile).toHaveBeenCalledWith('src/d.ts')
      expect(name('gone.ts').props.onPress).toBeUndefined()
    })

    it('opens a web search to its hits as links', () => {
      const tree = render([
        {
          type: 'tool-call',
          name: 'web_search',
          input: { query: 'FlatList docs' },
          webSearchResults: [{ title: 'FlatList', url: 'https://reactnative.dev/docs/flatlist' }]
        }
      ])
      openRow(tree, 'FlatList docs')
      const hit = tree.root.findAll(
        (node) => String(node.type) === 'Text' && node.props.accessibilityRole === 'link'
      )[0]!
      act(() => hit.props.onPress())
      expect(openExternalLink).toHaveBeenCalledWith('https://reactnative.dev/docs/flatlist')
    })
  })

  describe('task lists, as desktop draws them', () => {
    const todo = (statuses: string[]): NativeChatToolCallBlock => ({
      type: 'tool-call',
      name: 'TodoWrite',
      state: 'completed',
      input: {
        todos: statuses.map((status, index) => ({
          content: `Task ${index}`,
          status,
          activeForm: `Doing task ${index}`
        }))
      }
    })

    it('draws a first plan as its checklist, not as raw input', () => {
      const tree = render([
        todo(['completed', 'in_progress']),
        { type: 'tool-result', output: 'Todos updated' }
      ])
      expect(textIn(tree.root)).toEqual(
        expect.arrayContaining(['Updated the plan', 'Tasks', '1/2', 'Task 0', 'Doing task 1'])
      )
      expect(textIn(tree.root).some((text) => text.includes('todos'))).toBe(false)
      expect(textIn(tree.root)).not.toContain('Todos updated')
    })

    it('draws a later plan as what changed since the one before', () => {
      act(() => {
        renderer = create(
          createElement(ToolRun, {
            blocks: [todo(['completed', 'completed', 'pending'])],
            previousTodoWrite: todo(['completed', 'in_progress'])
          })
        )
      })
      openRun(renderer!)
      expect(textIn(renderer!.root)).toEqual(
        expect.arrayContaining(['Completed Task 1', 'Added Task 2', 'Full task list'])
      )
      expect(textIn(renderer!.root)).not.toContain('Task 0')
    })
  })

  describe("what the reader opened, kept above the list's recycled rows", () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Bash', input: { command: 'ls' }, state: 'completed' },
      { type: 'tool-result', output: 'a.ts' }
    ]

    function Transcript({ mounted }: { mounted: boolean }) {
      const disclosures = useMobileNativeChatDisclosures('host\0worktree\0tab')
      return createElement(
        MobileNativeChatDisclosureContext.Provider,
        { value: disclosures },
        mounted
          ? createElement(ToolRun, {
              blocks,
              disclosureId: 'a1'
            })
          : null
      )
    }

    function show(props: { mounted: boolean }): void {
      act(() => {
        if (renderer) {
          renderer.update(createElement(Transcript, props))
        } else {
          renderer = create(createElement(Transcript, props))
        }
      })
    }

    const press = (label: string): void => {
      act(() => {
        renderer!.root
          .findAll((node) => String(node.type) === 'Pressable')
          .findLast((node) => textIn(node).includes(label))!
          .props.onPress()
      })
    }

    it('keeps an opened run and line open after the row is recycled and drawn again', () => {
      show({ mounted: true })
      press('ls')
      press('ls')
      expect(textIn(renderer!.root)).toContain('a.ts')
      show({ mounted: false })
      show({ mounted: true })
      expect(textIn(renderer!.root)).toContain('a.ts')
    })

    const box = (): ReactTestInstance =>
      renderer!.root.findAll((node) => String(node.type) === 'ScrollView')[0]!
    const scrolled = (top: number) => ({
      nativeEvent: {
        contentOffset: { y: top },
        contentSize: { height: 1_000 },
        layoutMeasurement: { height: 300 }
      }
    })

    it('comes back where the reader left its box after the row is recycled', () => {
      show({ mounted: true })
      press('ls')
      act(() => {
        box().props.onScroll(scrolled(120))
      })
      show({ mounted: false })
      show({ mounted: true })
      scrolls.to.mockClear()
      act(() => {
        box().props.onContentSizeChange()
      })
      expect(scrolls.to).toHaveBeenCalledWith({ y: 120, animated: false })
    })
  })

  it('follows new work at the end of a live run, but holds still when the reader opens a row', () => {
    const live = (blocks: NativeChatBlock[]) =>
      createElement(ToolRun, {
        blocks,
        activeTurnIsWorking: true,
        trailing: true
      })
    const first: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Bash', input: { command: 'ls' }, state: 'completed' },
      { type: 'tool-result', output: 'a.ts' }
    ]
    act(() => {
      renderer = create(live(first))
    })
    openRun(renderer!)
    const box = () => renderer!.root.findAll((node) => String(node.type) === 'ScrollView')[0]!
    act(() => {
      box().props.onContentSizeChange()
    })
    scrolls.toEnd.mockClear()
    act(() => {
      renderer!.root
        .findAll((node) => String(node.type) === 'Pressable')
        .findLast((node) => textIn(node).includes('ls'))!
        .props.onPress()
    })
    act(() => {
      box().props.onContentSizeChange()
    })
    expect(scrolls.toEnd).not.toHaveBeenCalled()
    act(() => {
      renderer!.update(
        live([
          ...first,
          { type: 'tool-call', name: 'Bash', input: { command: 'pwd' }, state: 'running' }
        ])
      )
    })
    act(() => {
      box().props.onContentSizeChange()
    })
    expect(scrolls.toEnd).toHaveBeenCalledTimes(1)
  })

  it('does not save a follow for a later row opening when new work left the height unchanged', () => {
    const live = (blocks: NativeChatBlock[]) =>
      createElement(ToolRun, {
        blocks,
        activeTurnIsWorking: true,
        trailing: true
      })
    const call: NativeChatBlock = { type: 'tool-call', name: 'Bash', input: { command: 'ls' } }
    act(() => {
      renderer = create(live([call]))
    })
    openRun(renderer!)
    const box = () => renderer!.root.findAll((node) => String(node.type) === 'ScrollView')[0]!
    act(() => {
      box().props.onContentSizeChange()
    })
    act(() => {
      renderer!.update(live([call, { type: 'tool-result', output: 'a.ts' }]))
    })
    scrolls.toEnd.mockClear()
    act(() => {
      renderer!.root
        .findAll((node) => String(node.type) === 'Pressable')
        .findLast((node) => textIn(node).includes('ls'))!
        .props.onPress()
    })
    act(() => {
      box().props.onContentSizeChange()
    })
    expect(scrolls.toEnd).not.toHaveBeenCalled()
  })
})
