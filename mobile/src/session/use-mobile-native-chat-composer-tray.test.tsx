// The composer tray keeps one card list and one child-work strip per conversation, so an action
// still in flight in one never disables the same control in another, and the strip's open list
// outlives a roster that empties between sequential children.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../src/shared/agent-status-child-work-view'
import type { AgentSessionBackgroundTaskState } from '../../../src/shared/agent-session-wire'
import { agentChildRowContextForSessionStream } from '../../../src/shared/agent-child-row-stream-context'
import { structuredSessionBackgroundTasksView } from '../../../src/shared/structured-session-background-tasks-view'
import { useMobileNativeChatComposerTray } from './use-mobile-native-chat-composer-tray'
import type { MobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'

vi.mock('react-native', () => ({
  Dimensions: { get: () => ({ width: 430, height: 900 }) },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Activity: 'Activity',
  AlertCircle: 'AlertCircle',
  Bot: 'Bot',
  ChevronDown: 'ChevronDown',
  CircleHelp: 'CircleHelp',
  SquareTerminal: 'SquareTerminal',
  Workflow: 'Workflow',
  CornerDownRight: 'CornerDownRight',
  ListEnd: 'ListEnd',
  MoreHorizontal: 'MoreHorizontal',
  Pause: 'Pause',
  Pencil: 'Pencil',
  Play: 'Play',
  Send: 'Send',
  Trash2: 'Trash2'
}))

vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../components/AgentStateDot', () => ({
  AGENT_WORKING_COLOR: '#eab308',
  AgentStateDot: 'AgentStateDot'
}))
vi.mock('../hooks/use-now', () => ({ useNow: () => 100_000 }))

const CARD = {
  messageId: 'waiting-1',
  text: 'next',
  state: 'waiting' as const,
  paused: false,
  needsAttention: false,
  caption: null,
  attribution: null
}

const CHILD: AgentChildWorkView = {
  id: 'a',
  providerId: 'task-a',
  kind: 'agent',
  description: 'review a',
  state: 'working',
  membership: 'live',
  firstObservedAt: 90_000,
  observedAt: 99_000,
  stoppable: true,
  invocation: { invocationId: 'spawn-a', generation: 1 }
}
const RUNNING: AgentSessionBackgroundTaskState = { state: 'monitoring', children: [CHILD] }

function tasks(
  sessionKey: string,
  state: AgentSessionBackgroundTaskState | null
): MobileStructuredBackgroundTasks {
  return {
    sessionKey,
    view: structuredSessionBackgroundTasksView(state, null),
    rowContext: agentChildRowContextForSessionStream(true, 0),
    stop: vi.fn(async () => ({ status: 'rejected' as const }))
  }
}

const NEVER_RESUMES = (): Promise<boolean> => new Promise<boolean>(() => undefined)

function Slot({
  sessionKey,
  onResume = NEVER_RESUMES,
  backgroundTasks = null
}: {
  sessionKey: string
  onResume?: () => Promise<boolean>
  backgroundTasks?: MobileStructuredBackgroundTasks | null
}): React.JSX.Element {
  const tray = useMobileNativeChatComposerTray({
    queued: { cards: [CARD], pause: { reason: 'stopped' }, onResume, sessionKey },
    backgroundTasks
  })
  return createElement('View', null, tray.content)
}

describe('useMobileNativeChatComposerTray', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it("never lets one conversation's pending Resume disable another's", async () => {
    const pending = vi.fn(() => new Promise<boolean>(() => undefined))
    const mounted = create(createElement('View'))
    renderer = mounted
    const resume = () =>
      mounted.root.findByProps({ accessibilityLabel: 'Resume sending the queued messages' })
    await act(async () => {
      mounted.update(createElement(Slot, { sessionKey: 'session-a', onResume: pending }))
    })
    await act(async () => resume().props.onPress())
    expect(resume().props.disabled).toBe(true)
    await act(async () => {
      mounted.update(createElement(Slot, { sessionKey: 'session-b', onResume: pending }))
    })
    expect(resume().props.disabled).toBe(false)
  })

  function stripRows(mounted: ReactTestRenderer) {
    return mounted.root.findAll((node) => node.props.testID === 'background-task-row')
  }

  function openStrip(mounted: ReactTestRenderer): void {
    const header = mounted.root.find(
      (node) =>
        String(node.type) === 'Pressable' && node.props.accessibilityState?.expanded !== undefined
    )
    act(() => header.props.onPress())
  }

  it('keeps the strip open across a moment with nothing running', async () => {
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(
        createElement(Slot, { sessionKey: 's-a', backgroundTasks: tasks('s-a', RUNNING) })
      )
    })
    openStrip(mounted)
    expect(stripRows(mounted)).toHaveLength(1)
    await act(async () => {
      mounted.update(
        createElement(Slot, { sessionKey: 's-a', backgroundTasks: tasks('s-a', null) })
      )
    })
    expect(stripRows(mounted)).toHaveLength(0)
    await act(async () => {
      mounted.update(
        createElement(Slot, { sessionKey: 's-a', backgroundTasks: tasks('s-a', RUNNING) })
      )
    })
    expect(stripRows(mounted)).toHaveLength(1)
  })

  it("starts another conversation's strip closed", async () => {
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(
        createElement(Slot, { sessionKey: 's-a', backgroundTasks: tasks('s-a', RUNNING) })
      )
    })
    openStrip(mounted)
    expect(stripRows(mounted)).toHaveLength(1)
    await act(async () => {
      mounted.update(
        createElement(Slot, { sessionKey: 's-b', backgroundTasks: tasks('s-b', RUNNING) })
      )
    })
    expect(stripRows(mounted)).toHaveLength(0)
  })

  it('gives the strip and the cards of one conversation their own keys', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(
        createElement(Slot, { sessionKey: 's-a', backgroundTasks: tasks('s-a', RUNNING) })
      )
    })
    const duplicateKeys = consoleError.mock.calls.filter((call) =>
      String(call[0]).includes('same key')
    )
    consoleError.mockRestore()
    expect(duplicateKeys).toEqual([])
  })
})
