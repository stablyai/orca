import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppStateStatus } from 'react-native'

const appState = vi.hoisted(() => ({
  current: 'active',
  listeners: new Set<(state: AppStateStatus) => void>()
}))

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): unknown =>
    React.createElement('Text', props, children)
  return {
    AppState: {
      get currentState() {
        return appState.current
      },
      addEventListener: (_event: string, listener: (state: AppStateStatus) => void) => {
        appState.listeners.add(listener)
        return {
          remove: () => {
            appState.listeners.delete(listener)
          }
        }
      }
    },
    ActivityIndicator: (props: Record<string, unknown>) =>
      React.createElement('ActivityIndicator', props),
    Pressable: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Pressable', props, children),
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight' }))

import { MobileNativeChatTurnStatus } from './MobileNativeChatTurnStatus'
import {
  findAllByHostType,
  findByHostType
} from '../../../test-support/react-test-renderer-host-nodes'

const labels = (node: ReactTestInstance): string[] =>
  findAllByHostType(node, 'Text').map((text) => String(text.children.join('')))

const spinners = (node: ReactTestInstance): ReactTestInstance[] =>
  findAllByHostType(node, 'ActivityIndicator')

let renderer: ReactTestRenderer | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-04T00:00:00Z'))
  appState.current = 'active'
  appState.listeners.clear()
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('MobileNativeChatTurnStatus', () => {
  function changeAppState(state: AppStateStatus) {
    act(() => {
      appState.current = state
      for (const listener of appState.listeners) {
        listener(state)
      }
    })
  }
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
    const button = findByHostType(tree.root, 'Pressable')
    expect(button.props.accessibilityLabel).toBe('Toggle turn details')
    expect(button.props.accessibilityState).toEqual({ expanded: false })
    act(() => button.props.onPress())
    expect(onToggleExpanded).toHaveBeenCalledOnce()
  })

  it('heads a turn a crash cut off as worked, and a turn the user stopped as interrupted', () => {
    const crashed = render({
      startedAt: Date.now(),
      workedSeconds: 12,
      verdict: 'interruption',
      onToggleExpanded: vi.fn()
    })
    expect(labels(crashed.root)).toEqual(['Worked for 12s'])
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
    expect(findAllByHostType(tree.root, 'Pressable')).toHaveLength(0)
    expect(labels(tree.root)).toEqual(['Worked for 5s'])
  })

  it('holds no interval once the turn has settled', () => {
    render({ startedAt: Date.now(), workedSeconds: 5 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops clock callbacks in the background and catches up immediately on resume', () => {
    const tree = render({ startedAt: Date.now() })
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(labels(tree.root)).toEqual(['Working for 2s'])

    changeAppState('background')
    const clockReads = vi.spyOn(Date, 'now')
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(clockReads).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(labels(tree.root)).toEqual(['Working for 2s'])

    changeAppState('active')
    expect(labels(tree.root)).toEqual(['Working for 1m 2s'])
    expect(vi.getTimerCount()).toBe(1)
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(labels(tree.root)).toEqual(['Working for 1m 3s'])
  })

  it('keeps the original pre-stamp epoch through background and settlement transitions', () => {
    const tree = render({ startedAt: null })
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(labels(tree.root)).toEqual(['Working for 3s'])
    changeAppState('background')
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    act(() =>
      tree.update(createElement(MobileNativeChatTurnStatus, { startedAt: null, workedSeconds: 8 }))
    )
    changeAppState('active')
    expect(labels(tree.root)).toEqual(['Worked for 8s'])
    expect(vi.getTimerCount()).toBe(0)

    act(() => tree.update(createElement(MobileNativeChatTurnStatus, { startedAt: null })))
    expect(labels(tree.root)).toEqual(['Working for 13s'])
    expect(vi.getTimerCount()).toBe(1)
    act(() => tree.unmount())
    expect(vi.getTimerCount()).toBe(0)
    expect(appState.listeners.size).toBe(0)
  })

  it('creates no clock while initially backgrounded and uses a supplied start time on resume', () => {
    appState.current = 'background'
    const startedAt = Date.now() - 5_000
    const tree = render({ startedAt })
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(15_000)
    })
    changeAppState('active')
    expect(labels(tree.root)).toEqual(['Working for 20s'])
    expect(vi.getTimerCount()).toBe(1)
  })
})
