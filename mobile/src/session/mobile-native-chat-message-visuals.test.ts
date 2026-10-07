import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  MobileNativeChatVisualContext,
  type MobileNativeChatVisualRender
} from './mobile-native-chat-visual-context'

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

const renderVisual: MobileNativeChatVisualRender = () => 'visual'

function message(id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: null, source: 'transcript' }
}

describe('MobileNativeChatMessage visuals', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function markdownProps(
    row: NativeChatMessage,
    options: {
      visuals?: MobileNativeChatVisualRender | null
      activeTurnIsWorking?: boolean
      mayStillGrow?: boolean
    } = {}
  ): Record<string, unknown> {
    act(() => {
      renderer = create(
        createElement(
          MobileNativeChatVisualContext.Provider,
          { value: options.visuals === undefined ? renderVisual : options.visuals },
          createElement(MobileNativeChatMessage, {
            message: row,
            activeTurnIsWorking: options.activeTurnIsWorking,
            mayStillGrow: options.mayStillGrow ?? true
          })
        )
      )
    })
    return renderer!.root.find((node) => String(node.type) === 'MobileMarkdown').props
  }

  it("renders a finished assistant reply's directives through the transcript renderer", () => {
    const props = markdownProps(message('a1', 'assistant', '::orca-visual{file="a.html"}'))
    expect(props.renderVisual).toBe(renderVisual)
    expect(props.content).toBe('::orca-visual{file="a.html"}')
  })

  it('hides a directive still being typed while its turn works, and mounts finished lines', () => {
    const props = markdownProps(
      message(
        'a1',
        'assistant',
        '::orca-visual{file="done.html"}\nChart below.\n::orca-visual{file="usage"}'
      ),
      { activeTurnIsWorking: true }
    )
    expect(props.renderVisual).toBe(renderVisual)
    expect(props.content).toBe('::orca-visual{file="done.html"}\nChart below.\n')
  })

  it('shows an earlier finished row of a working turn in full', () => {
    const text = 'Pick one:\n::orca-visual{file="options.html"}'
    expect(
      markdownProps(message('a0', 'assistant', text), {
        activeTurnIsWorking: true,
        mayStillGrow: false
      }).content
    ).toBe(text)
  })

  it('holds back only the last block of the row: text followed by a tool call is finished', () => {
    const text = 'Options:\n::orca-visual{file="options'
    const row: NativeChatMessage = {
      id: 'a1',
      role: 'assistant',
      blocks: [
        { type: 'text', text },
        { type: 'tool-call', name: 'AskUserQuestion', input: {} }
      ],
      timestamp: null,
      source: 'transcript'
    }
    expect(markdownProps(row, { activeTurnIsWorking: true }).content).toBe(text)
  })

  it('shows the whole reply once its turn settles', () => {
    const text = 'Chart below.\n::orca-visual{file="usage'
    expect(markdownProps(message('a1', 'assistant', text)).content).toBe(text)
  })

  it('leaves directives as text where the chat has no visual source', () => {
    const props = markdownProps(message('a1', 'assistant', '::orca-visual{file="a.html"}'), {
      visuals: null,
      activeTurnIsWorking: true
    })
    expect(props.renderVisual).toBeUndefined()
    expect(props.content).toBe('::orca-visual{file="a.html"}')
  })

  it('never renders visuals in system rows', () => {
    const props = markdownProps(message('s1', 'system', '::orca-visual{file="a.html"}'))
    expect(props.renderVisual).toBeUndefined()
  })
})
