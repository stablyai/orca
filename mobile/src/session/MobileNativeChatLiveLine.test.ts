import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveReasoning } from '../../../src/shared/native-chat-reasoning-row'

const pressableMounts = vi.hoisted(() => ({ count: 0 }))

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }): ReactNode =>
      React.createElement(name, props, children)
  // Counts mounts, so a test can tell the live region was kept rather than replaced.
  const Pressable = ({ children, ...props }: { children?: ReactNode }): ReactNode => {
    React.useEffect(() => {
      pressableMounts.count += 1
    }, [])
    return React.createElement('Pressable', props, children)
  }
  return {
    ActivityIndicator: host('ActivityIndicator'),
    Platform: { OS: 'ios' },
    Pressable,
    Text: host('Text'),
    View: host('View'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight' }))
vi.mock('./MobileNativeChatReasoningRow', () => ({
  MobileNativeChatReasoningBody: 'ReasoningBody'
}))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

import { MobileNativeChatLiveLine } from './MobileNativeChatLiveLine'

const block: NativeChatLiveReasoning = {
  message: {
    id: 'r-1',
    role: 'reasoning',
    blocks: [{ type: 'text', text: 'Weighing two approaches' }],
    timestamp: null,
    source: 'transcript',
    state: 'running'
  },
  markdown: 'Weighing two approaches'
}

describe('MobileNativeChatLiveLine', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    pressableMounts.count = 0
  })

  const onToggleReasoning = vi.fn()
  function element(
    fields: {
      thinking?: boolean
      activityText?: string | null
      reasoning?: NativeChatLiveReasoning | null
      reasoningExpanded?: boolean
    } = {}
  ) {
    return createElement(MobileNativeChatLiveLine, {
      line: {
        thinking: true,
        activityText: null,
        reasoning: null,
        reasoningExpanded: false,
        ...fields
      },
      onToggleReasoning,
      fontScale: 1
    })
  }
  function render(fields: Parameters<typeof element>[0] = {}): ReactTestInstance {
    act(() => {
      renderer = create(element(fields))
    })
    return renderer!.root
  }
  const byType = (root: ReactTestInstance, type: string): ReactTestInstance[] =>
    root.findAll((node) => String(node.type) === type)
  const labels = (root: ReactTestInstance): string[] =>
    byType(root, 'Text').map((text) => String(text.children.join('')))
  const header = (root: ReactTestInstance): ReactTestInstance =>
    root.find((node) => String(node.type) === 'Pressable')

  it('reads "Thinking" beside one spinner while the turn reasons', () => {
    const root = render()
    expect(labels(root)).toEqual(['Thinking'])
    expect(byType(root, 'ActivityIndicator')).toHaveLength(1)
  })

  // The bar owns the clock; the tail line never repeats it.
  it('reads plain "Working…" when the turn is not reasoning, and holds no timer', () => {
    vi.useFakeTimers()
    const root = render({ thinking: false })
    expect(labels(root)).toEqual(['Working…'])
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('lets provider activity text beat both fallbacks', () => {
    expect(labels(render({ activityText: 'Running pnpm test' }))).toEqual(['Running pnpm test'])
  })

  it('announces what it says to assistive tech, and is no button while it discloses nothing', () => {
    const line = header(render())
    expect(line.props.accessibilityLiveRegion).toBe('polite')
    expect(line.props.accessibilityLabel).toBe('Thinking')
    expect(line.props.accessibilityRole).toBeUndefined()
    expect(line.props.onPress).toBeUndefined()
  })

  it('discloses the open block under one "Thinking", collapsed, toggled by its block key', () => {
    const root = render({ reasoning: block })
    expect(labels(root)).toEqual(['Thinking'])
    const line = header(root)
    expect(line.props.accessibilityRole).toBe('button')
    expect(line.props.accessibilityState).toEqual({ expanded: false })
    expect(byType(root, 'ReasoningBody')).toHaveLength(0)
    act(() => line.props.onPress())
    expect(onToggleReasoning).toHaveBeenCalledWith('reasoning:r-1')
  })

  it('shows the live text outside the live region once opened', () => {
    const root = render({ reasoning: block, reasoningExpanded: true })
    const [body] = byType(root, 'ReasoningBody')
    expect(body?.props.markdown).toBe('Weighing two approaches')
    let ancestor = body?.parent ?? null
    while (ancestor) {
      expect(ancestor.props.accessibilityLiveRegion).toBeUndefined()
      ancestor = ancestor.parent
    }
    // iOS selects inline, so the body takes no long press.
    expect(body?.props.onLongPress).toBeUndefined()
  })

  it('keeps one live region while it turns into the disclosure and back', () => {
    render({ thinking: false })
    act(() => renderer!.update(element({ reasoning: block })))
    expect(header(renderer!.root).props.accessibilityLabel).toBe('Thinking')
    act(() => renderer!.update(element({ thinking: false })))
    expect(header(renderer!.root).props.accessibilityLabel).toBe('Working…')
    expect(pressableMounts.count).toBe(1)
  })
})
