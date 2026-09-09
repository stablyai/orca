import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: unknown }): unknown =>
    React.createElement('Text', props, children)
  return {
    Animated: {
      Text,
      Value: class {
        constructor(private value: number) {}
        setValue(next: number): void {
          this.value = next
        }
      },
      loop: (animation: unknown) => animation,
      sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
      timing: () => ({ start: vi.fn(), stop: vi.fn() })
    },
    Pressable: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('Pressable', props, children),
    Text,
    View: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight' }))

import { MobileNativeChatTurnStatus } from './MobileNativeChatTurnStatus'

describe('MobileNativeChatTurnStatus', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00Z'))
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  function render(props: {
    startedAt: number | null
    thinking: boolean
    workedSeconds?: number | null
    expanded?: boolean
    onToggleExpanded?: () => void
  }): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatTurnStatus, props))
    })
    return renderer!
  }

  const labels = (node: ReactTestInstance): string[] =>
    node.findAllByType('Text' as never).map((text) => String(text.children.join('')))

  it('reads "Thinking" before the turn produces output', () => {
    const tree = render({ startedAt: Date.now(), thinking: true })
    expect(labels(tree.root)).toEqual(['Thinking'])
  })

  it('counts up once the turn is producing output', () => {
    const startedAt = Date.now()
    const tree = render({ startedAt, thinking: false })
    expect(labels(tree.root)).toEqual(['Working for 0s'])
    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(labels(tree.root)).toEqual(['Working for 12s'])
  })

  it('settles to a tappable "Worked for" row that toggles the turn', () => {
    const onToggleExpanded = vi.fn()
    const tree = render({
      startedAt: Date.now(),
      thinking: false,
      workedSeconds: 184,
      onToggleExpanded
    })
    expect(labels(tree.root)).toEqual(['Worked for 3m 4s'])
    const button = tree.root.findByType('Pressable' as never)
    expect(button.props.accessibilityLabel).toBe('Toggle turn details')
    expect(button.props.accessibilityState).toEqual({ expanded: false })
    act(() => button.props.onPress())
    expect(onToggleExpanded).toHaveBeenCalledOnce()
  })

  it('stays a plain row when the settled turn has nothing to disclose', () => {
    const tree = render({ startedAt: Date.now(), thinking: false, workedSeconds: 5 })
    expect(tree.root.findAllByType('Pressable' as never)).toHaveLength(0)
    expect(labels(tree.root)).toEqual(['Worked for 5s'])
  })

  it('holds no interval once the turn has settled', () => {
    render({ startedAt: Date.now(), thinking: false, workedSeconds: 5 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('announces the live row to assistive tech', () => {
    const tree = render({ startedAt: Date.now(), thinking: true })
    const row = tree.root.findByType('View' as never)
    expect(row.props.accessibilityLiveRegion).toBe('polite')
    expect(row.props.accessibilityLabel).toBe('Agent is responding')
  })
})
