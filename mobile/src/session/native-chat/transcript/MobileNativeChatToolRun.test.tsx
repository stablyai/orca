import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NativeChatBlock } from '../../../../../src/shared/native-chat/native-chat-types'

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
import { ToolRun } from './MobileNativeChatToolRun'
import {
  MobileNativeChatDisclosureContext,
  useMobileNativeChatDisclosures
} from './mobile-native-chat-disclosure-store'

describe('ToolRun', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function openRun(tree: ReactTestRenderer): void {
    act(() => {
      tree.root.findAll((node) => String(node.type) === 'Pressable')[0]!.props.onPress()
    })
  }

  const textIn = (node: ReactTestInstance): string[] =>
    node
      .findAll((node) => String(node.type) === 'Text')
      .map((text) => String(text.children.join('')))

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
