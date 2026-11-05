import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentChildRowContextForSessionStream } from '../../../../../src/shared/agent-status/presentation/agent-child-row-stream-context'
import type { AgentChildWorkView } from '../../../../../src/shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentSessionBackgroundTaskState } from '../../../../../src/shared/agent-session/agent-session-background-task-wire'
import { structuredSessionBackgroundTasksView } from '../../../../../src/shared/structured-session-background-tasks-view'
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
vi.mock('../../../components/AgentStateDot', () => ({
  AGENT_WORKING_COLOR: '#eab308',
  AgentStateDot: 'AgentStateDot'
}))
vi.mock('../../../hooks/use-now', () => ({ useNow: () => NOW }))

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
type StopResult = Awaited<ReturnType<Props['tasks']['stop']>>

const REJECTED: StopResult = { status: 'rejected' }
const UNCONFIRMED: StopResult = { status: 'unknown' }
const STOPPED: StopResult = { status: 'accepted', value: { cancelled: true }, sameFence: true }
const NOTHING_STOPPED: StopResult = {
  status: 'accepted',
  value: { cancelled: false },
  sameFence: true
}

function tasksFor(
  state: AgentSessionBackgroundTaskState | null,
  options: {
    streamLive?: boolean
    hostClockOffsetMs?: number
    stop?: Props['tasks']['stop']
  } = {}
): Props['tasks'] {
  return {
    view: structuredSessionBackgroundTasksView(state, null),
    rowContext: agentChildRowContextForSessionStream(
      options.streamLive ?? true,
      options.hostClockOffsetMs ?? 0
    ),
    sessionKey: 'session-a',
    stop: options.stop ?? vi.fn(async () => REJECTED)
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

  it('stops one row by its provider id and holds its button while the Stop is on its way', async () => {
    let finish: (result: StopResult) => void = () => {}
    const stop = vi.fn(() => new Promise<StopResult>((resolve) => (finish = resolve)))
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
    await act(async () => finish(UNCONFIRMED))
    expect(stopButtons(mounted)[0]!.props.disabled).toBe(false)
  })

  it('keeps a confirmed Stop held until its row leaves, and offers it again if the row comes back', async () => {
    let finish: (result: StopResult) => void = () => {}
    const stop = vi.fn(() => new Promise<StopResult>((resolve) => (finish = resolve)))
    const running = { state: 'monitoring' as const, supportsTaskStop: true }
    const mounted = mount(tasksFor({ ...running, children: [view('a'), view('b')] }, { stop }))
    const show = (children: AgentChildWorkView[]) =>
      act(() => {
        mounted.update(
          createElement(MobileNativeChatBackgroundTasks, {
            tasks: tasksFor({ ...running, children }, { stop })
          })
        )
      })
    expand(mounted)
    act(() => stopButtons(mounted)[0]!.props.onPress())
    await act(async () => finish(STOPPED))
    expect(stopButtons(mounted).map((button) => button.props.disabled)).toEqual([true, false])
    show([view('b')])
    show([view('a'), view('b')])
    expect(stopButtons(mounted).map((button) => button.props.disabled)).toEqual([false, false])
    act(() => stopButtons(mounted)[0]!.props.onPress())
    await act(async () => finish(NOTHING_STOPPED))
    expect(stopButtons(mounted)[0]!.props.disabled).toBe(false)
  })

  it("offers Stop again on a helper's next run, which reuses the stopped run's row id", async () => {
    let finish: (result: StopResult) => void = () => {}
    const stop = vi.fn(() => new Promise<StopResult>((resolve) => (finish = resolve)))
    const running = { state: 'monitoring' as const, supportsTaskStop: true }
    const mounted = mount(tasksFor({ ...running, children: [view('a')] }, { stop }))
    expand(mounted)
    act(() => stopButtons(mounted)[0]!.props.onPress())
    await act(async () => finish(STOPPED))
    expect(stopButtons(mounted)[0]!.props.disabled).toBe(true)
    act(() => {
      mounted.update(
        createElement(MobileNativeChatBackgroundTasks, {
          tasks: tasksFor(
            {
              ...running,
              children: [view('a', { invocation: { invocationId: 'turn-2', generation: 2 } })]
            },
            { stop }
          )
        })
      )
    })
    expect(stopButtons(mounted)[0]!.props.disabled).toBe(false)
  })

  it('offers Stop all only to a host with no per-row stop that still accepts one', async () => {
    let finish: (result: StopResult) => void = () => {}
    const stop = vi.fn(() => new Promise<StopResult>((resolve) => (finish = resolve)))
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
    await act(async () => finish(STOPPED))
    expect(stopButtons(fallback)[0]!.props.disabled).toBe(false)
    const none = mount(
      tasksFor({ state: 'monitoring', supportsStopAll: false, children: [view('a')] })
    )
    expand(none)
    expect(stopButtons(none)).toEqual([])
  })
})
