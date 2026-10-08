import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: unknown }): unknown =>
    React.createElement('Text', props, children)
  return {
    ActivityIndicator: (props: Record<string, unknown>) =>
      React.createElement('ActivityIndicator', props),
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

const labels = (node: ReactTestInstance): string[] =>
  node.findAllByType('Text' as never).map((text) => String(text.children.join('')))

const spinners = (node: ReactTestInstance): ReactTestInstance[] =>
  node.findAllByType('ActivityIndicator' as never)

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

describe('MobileNativeChatTurnStatus', () => {
  function render(props: {
    startedAt: number | null
    workedSeconds?: number | null
    verdict?: 'interruption' | 'cancellation'
    expanded?: boolean
    onToggleExpanded?: () => void
  }): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatTurnStatus, props))
    })
    return renderer!
  }

  it('counts up from the first second while the turn runs, with no spinner', () => {
    const tree = render({ startedAt: Date.now() })
    expect(labels(tree.root)).toEqual(['Working for 0s'])
    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(labels(tree.root)).toEqual(['Working for 12s'])
    expect(spinners(tree.root)).toHaveLength(0)
  })

  it('settles to a tappable "Worked for" row that toggles the turn', () => {
    const onToggleExpanded = vi.fn()
    const tree = render({ startedAt: Date.now(), workedSeconds: 184, onToggleExpanded })
    expect(labels(tree.root)).toEqual(['Worked for 3m 4s'])
    const button = tree.root.findByType('Pressable' as never)
    expect(button.props.accessibilityLabel).toBe('Toggle turn details')
    expect(button.props.accessibilityState).toEqual({ expanded: false })
    act(() => button.props.onPress())
    expect(onToggleExpanded).toHaveBeenCalledOnce()
  })

  // A crash cut reads interrupted, as a Stop does; the crash's notice row explains why.
  it('heads a turn a crash cut off and a turn the user stopped alike as interrupted', () => {
    const crashed = render({
      startedAt: Date.now(),
      workedSeconds: 12,
      verdict: 'interruption',
      onToggleExpanded: vi.fn()
    })
    expect(labels(crashed.root)).toEqual(['Interrupted after 12s'])
    act(() => crashed.unmount())
    const stopped = render({
      startedAt: Date.now(),
      workedSeconds: 12,
      verdict: 'cancellation',
      onToggleExpanded: vi.fn()
    })
    expect(labels(stopped.root)).toEqual(['Interrupted after 12s'])
  })

  it('stays a plain row when the settled turn has nothing to disclose', () => {
    const tree = render({ startedAt: Date.now(), workedSeconds: 5 })
    expect(tree.root.findAllByType('Pressable' as never)).toHaveLength(0)
    expect(labels(tree.root)).toEqual(['Worked for 5s'])
  })

  it('holds no interval once the turn has settled', () => {
    render({ startedAt: Date.now(), workedSeconds: 5 })
    expect(vi.getTimerCount()).toBe(0)
  })
})
