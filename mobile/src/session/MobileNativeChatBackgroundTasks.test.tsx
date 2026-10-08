import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentChildRowContextForSessionStream } from '../../../src/shared/agent-child-row-stream-context'
import type { AgentChildWorkView } from '../../../src/shared/agent-status-child-work-view'
import type { AgentSessionBackgroundTaskState } from '../../../src/shared/agent-session-wire'
import { structuredSessionBackgroundTasksView } from '../../../src/shared/structured-session-background-tasks-view'
import { MobileNativeChatBackgroundTasks } from './MobileNativeChatBackgroundTasks'

const NOW = 10_000_000
const windowWidth = vi.hoisted(() => ({ value: 430 }))

vi.mock('react-native', () => ({
  Dimensions: { get: () => ({ width: windowWidth.value, height: 900 }) },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Activity: 'Activity',
  Bot: 'Bot',
  ChevronDown: 'ChevronDown',
  CircleHelp: 'CircleHelp',
  SquareTerminal: 'SquareTerminal',
  Workflow: 'Workflow'
}))
vi.mock('../components/AgentStateDot', () => ({
  AGENT_WORKING_COLOR: '#eab308',
  AgentStateDot: 'AgentStateDot'
}))
vi.mock('../hooks/use-now', () => ({ useNow: () => NOW }))

function view(id: string, overrides: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id,
    providerId: `task-${id}`,
    kind: 'agent',
    description: `review ${id}`,
    state: 'working',
    membership: 'live',
    firstObservedAt: NOW - 65_000,
    observedAt: NOW - 1_000,
    stoppable: true,
    invocation: { invocationId: `spawn-${id}`, generation: 1 },
    ...overrides
  }
}

type Props = Parameters<typeof MobileNativeChatBackgroundTasks>[0]

function tasksFor(
  state: AgentSessionBackgroundTaskState | null,
  options: {
    streamLive?: boolean
    hostClockOffsetMs?: number
    stop?: (taskId?: string) => Promise<unknown>
  } = {}
): Props['tasks'] {
  return {
    view: structuredSessionBackgroundTasksView(state, null),
    rowContext: agentChildRowContextForSessionStream(
      options.streamLive ?? true,
      options.hostClockOffsetMs ?? 0
    ),
    sessionKey: 'session-a',
    stop: options.stop ?? vi.fn(async () => undefined)
  }
}

describe('MobileNativeChatBackgroundTasks', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    windowWidth.value = 430
  })

  function mount(tasks: Props['tasks']): ReactTestRenderer {
    act(() => renderer?.unmount())
    const mounted = create(createElement('View'))
    renderer = mounted
    act(() => {
      mounted.update(createElement(MobileNativeChatBackgroundTasks, { tasks }))
    })
    return mounted
  }

  function textOf(node: ReactTestInstance): string {
    return node.children
      .map((child) => (typeof child === 'string' ? child : textOf(child)))
      .join('')
  }

  function styleOf(node: ReactTestInstance): Record<string, unknown> {
    const rendered: unknown =
      typeof node.props.style === 'function'
        ? node.props.style({ pressed: false })
        : node.props.style
    const parts = Array.isArray(rendered) ? rendered : [rendered]
    return Object.assign(
      {},
      ...parts.filter(
        (part): part is Record<string, unknown> => typeof part === 'object' && part !== null
      )
    )
  }

  function header(mounted: ReactTestRenderer): ReactTestInstance {
    return mounted.root.findAll(
      (node) =>
        String(node.type) === 'Pressable' && node.props.accessibilityState?.expanded !== undefined
    )[0]!
  }

  function expand(mounted: ReactTestRenderer): void {
    act(() => header(mounted).props.onPress())
  }

  function stopButtons(mounted: ReactTestRenderer): ReactTestInstance[] {
    return mounted.root.findAll(
      (node) =>
        String(node.type) === 'Pressable' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('Stop')
    )
  }

  it('draws nothing while no child work runs', () => {
    expect(mount(tasksFor(null)).toJSON()).toBeNull()
    expect(
      mount(
        tasksFor({ state: 'monitoring', settledTasks: [{ id: 'old', kind: 'agent' }] })
      ).toJSON()
    ).toBeNull()
  })

  it('counts by kind on a wide strip and drops to a total once narrow', () => {
    const mounted = mount(
      tasksFor({
        state: 'monitoring',
        children: [view('a'), view('b'), view('s', { kind: 'command', description: 'npm test' })]
      })
    )
    expect(header(mounted).props.accessibilityLabel).toBe('2 agents · 1 shell')
    const strip = mounted.root.find((node) => node.props.testID === 'background-tasks-strip')
    act(() => strip.props.onLayout({ nativeEvent: { layout: { width: 343 } } }))
    expect(header(mounted).props.accessibilityLabel).toBe('3 background tasks')
  })

  it('starts narrow on a phone-width window, as desktop starts from its viewport', () => {
    windowWidth.value = 375
    const mounted = mount(
      tasksFor({
        state: 'monitoring',
        children: [view('a'), view('s', { kind: 'command', description: 'npm test' })]
      })
    )
    expect(header(mounted).props.accessibilityLabel).toBe('2 background tasks')
  })

  it('leads with a waiting agent and its reason', () => {
    const mounted = mount(
      tasksFor({ state: 'monitoring', children: [view('a', { state: 'waiting' })] })
    )
    expect(header(mounted).props.accessibilityLabel).toBe('1 agent waiting — needs approval')
  })

  it('opens to rows grouped by kind, with tokens and elapsed', () => {
    const mounted = mount(
      tasksFor({ state: 'monitoring', children: [view('a', { totalTokens: 18_130 })] })
    )
    expect(
      mounted.root.findAll((node) => node.props.testID === 'background-task-row')
    ).toHaveLength(0)
    expand(mounted)
    const rows = mounted.root.findAll((node) => node.props.testID === 'background-task-row')
    expect(rows.map(textOf)).toEqual(['review a · Agent18.1k · 1m 5s'])
    // Uppercased by style, so a screen reader hears the word itself.
    const label = mounted.root.find(
      (node) => String(node.type) === 'Text' && node.props.children === 'Agents'
    )
    expect(label.props.style).toMatchObject({ textTransform: 'uppercase' })
  })

  it('keeps the collapsed header compact and requests a 44pt hit rectangle', () => {
    const mounted = mount(tasksFor({ state: 'monitoring', children: [view('a')] }))
    const toggle = header(mounted)
    const style = styleOf(toggle)
    expect(style.minHeight).toBe(36)
    expect(toggle.props.hitSlop).toBe(4)
    // Requested geometry only: the native parent can bound hitSlop.
    expect(Number(style.minHeight) + 2 * toggle.props.hitSlop).toBe(44)
    expect(style.height).toBeUndefined()
    expect(style.maxHeight).toBeUndefined()
    expect(toggle.props.accessibilityState.expanded).toBe(false)
    expand(mounted)
    expect(header(mounted).props.accessibilityState.expanded).toBe(true)
    expand(mounted)
    expect(header(mounted).props.accessibilityState.expanded).toBe(false)
  })

  it('uses compact rows and Stop controls with tight group spacing', () => {
    const mounted = mount(
      tasksFor({ state: 'monitoring', supportsTaskStop: true, children: [view('a'), view('b')] })
    )
    expand(mounted)
    const rows = mounted.root.findAll((node) => node.props.testID === 'background-task-row')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.type).toBe('View')
      expect(row.props.hitSlop).toBeUndefined()
      expect(styleOf(row).minHeight).toBe(32)
    }
    const stops = stopButtons(mounted)
    expect(stops).toHaveLength(2)
    for (const stop of stops) {
      const style = styleOf(stop)
      expect(style).toMatchObject({ minHeight: 32, minWidth: 44 })
      expect(stop.props.hitSlop).toBe(6)
      expect(Number(style.minHeight) + 2 * stop.props.hitSlop).toBe(44)
    }
    const label = mounted.root.find(
      (node) => String(node.type) === 'Text' && node.props.children === 'Agents'
    )
    expect(label.parent?.props.style).toMatchObject({ paddingTop: 4, paddingBottom: 4 })
    expect(styleOf(label).paddingBottom).toBe(2)
  })

  it('lets compact content grow with Dynamic Type and ellipsizes single-line fields', () => {
    windowWidth.value = 320
    const mounted = mount(
      tasksFor({
        state: 'monitoring',
        supportsTaskStop: true,
        children: [view('a', { state: 'waiting', description: 'A long agent task '.repeat(20) })]
      })
    )
    expand(mounted)
    const row = mounted.root.find((node) => node.props.testID === 'background-task-row')
    const rowText = row.find(
      (node) => String(node.type) === 'Text' && node.props.numberOfLines === 1
    )
    expect(rowText.props.ellipsizeMode).toBe('tail')
    expect(styleOf(rowText)).toMatchObject({ flex: 1, minWidth: 0, fontSize: 12 })
    const headerTexts = header(mounted).findAll((node) => String(node.type) === 'Text')
    for (const text of headerTexts) {
      expect(text.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'tail' })
      expect(styleOf(text)).toMatchObject({ flexShrink: 1, fontSize: 12 })
    }
    for (const node of mounted.root.findAll((node) =>
      ['View', 'Text', 'Pressable'].includes(String(node.type))
    )) {
      expect(styleOf(node).height).toBeUndefined()
      expect(styleOf(node).maxHeight).toBeUndefined()
      expect(styleOf(node).lineHeight).toBeUndefined()
      if (String(node.type) === 'Text') {
        expect(node.props.allowFontScaling).not.toBe(false)
        expect(node.props.maxFontSizeMultiplier).toBeUndefined()
      }
    }
  })

  it('stops one row by its provider id and holds its button while the Stop is on its way', async () => {
    let finish: () => void = () => {}
    const stop = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const mounted = mount(
      tasksFor(
        {
          state: 'monitoring',
          supportsTaskStop: true,
          children: [view('a'), view('b', { stoppable: false })]
        },
        { stop }
      )
    )
    expand(mounted)
    const buttons = stopButtons(mounted)
    expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual(['Stop review a'])
    act(() => buttons[0]!.props.onPress())
    act(() => buttons[0]!.props.onPress())
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith('task-a')
    expect(stopButtons(mounted)[0]!.props.disabled).toBe(true)
    await act(async () => finish())
    expect(stopButtons(mounted)[0]!.props.disabled).toBe(false)
  })

  it('offers Stop all only to a host with no per-row stop that still accepts one', async () => {
    let finish: () => void = () => {}
    const stop = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const fallback = mount(tasksFor({ state: 'monitoring', children: [view('a')] }, { stop }))
    expand(fallback)
    expect(stopButtons(fallback).map((button) => button.props.accessibilityLabel)).toEqual([
      'Stop background tasks'
    ])
    const button = stopButtons(fallback)[0]!
    expect(styleOf(button)).toMatchObject({ minHeight: 32, minWidth: 44 })
    expect(button.props.hitSlop).toBe(6)
    expect(Number(styleOf(button).minHeight) + 2 * button.props.hitSlop).toBe(44)
    act(() => button.props.onPress())
    act(() => button.props.onPress())
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith(undefined)
    expect(stopButtons(fallback)[0]!.props.disabled).toBe(true)
    await act(async () => finish())
    expect(stopButtons(fallback)[0]!.props.disabled).toBe(false)
    const none = mount(
      tasksFor({ state: 'monitoring', supportsStopAll: false, children: [view('a')] })
    )
    expand(none)
    expect(stopButtons(none)).toEqual([])
  })

  it("reads an older host's task roster when it publishes no child views", () => {
    const mounted = mount(
      tasksFor({
        state: 'monitoring',
        tasks: [
          { id: 'a', kind: 'agent', state: 'working', startedAt: NOW - 1_000 },
          { id: 'b', kind: 'agent', state: 'waiting', startedAt: NOW - 1_000 }
        ]
      })
    )
    expect(header(mounted).props.accessibilityLabel).toBe('2 agents — 1 working, 1 waiting')
    expand(mounted)
    expect(
      mounted.root.findAll((node) => node.props.testID === 'background-task-row').map(textOf)
    ).toEqual(['Background agent1s', 'Background agent · needs approval1s'])
  })

  it("reads elapsed on the host's clock when the phone's runs ahead", () => {
    // The phone is 30 s ahead of the host that stamped the child's start.
    const mounted = mount(
      tasksFor(
        { state: 'monitoring', children: [view('a', { totalTokens: 900 })] },
        { hostClockOffsetMs: 30_000 }
      )
    )
    expand(mounted)
    expect(
      mounted.root.findAll((node) => node.props.testID === 'background-task-row').map(textOf)
    ).toEqual(['review a · Agent900 · 35s'])
  })

  it('starts narrow when the window less its margins is narrow', () => {
    windowWidth.value = 400
    const mounted = mount(
      tasksFor({
        state: 'monitoring',
        children: [view('a'), view('s', { kind: 'command', description: 'npm test' })]
      })
    )
    expect(header(mounted).props.accessibilityLabel).toBe('2 background tasks')
  })

  it('keeps one kind in its state forms on a phone-width strip', () => {
    windowWidth.value = 375
    const waiting = mount(
      tasksFor({
        state: 'monitoring',
        children: [view('a', { state: 'waiting' }), view('b', { state: 'waiting' })]
      })
    )
    expect(header(waiting).props.accessibilityLabel).toBe('2 agents waiting — needs approval')
    const mixed = mount(
      tasksFor({ state: 'monitoring', children: [view('a'), view('b', { state: 'waiting' })] })
    )
    expect(header(mixed).props.accessibilityLabel).toBe('2 agents — 1 working, 1 waiting')
  })

  it('cuts the header off on one line on the smallest phones, never wrapping it', () => {
    windowWidth.value = 320
    const mounted = mount(
      tasksFor({
        state: 'monitoring',
        children: [view('a'), view('b', { state: 'waiting' }), view('c', { state: 'unverifiable' })]
      })
    )
    const texts = header(mounted).findAll((node) => String(node.type) === 'Text')
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.map((text) => [text.props.numberOfLines, text.props.ellipsizeMode])).toEqual(
      texts.map(() => [1, 'tail'])
    )
  })

  it('claims no live work once the stream is lost', () => {
    const mounted = mount(
      tasksFor({ state: 'monitoring', children: [view('a'), view('b')] }, { streamLive: false })
    )
    expect(header(mounted).props.accessibilityLabel).toBe('2 agents with status unavailable')
    expand(mounted)
    const dots = mounted.root.findAll((node) => String(node.type) === 'AgentStateDot')
    expect(dots.map((dot) => dot.props.state)).toEqual(['unverifiable', 'unverifiable'])
    expect(textOf(mounted.root)).toContain('review a · No update in 0m')
  })
})
