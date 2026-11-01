import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatSubagentActivity } from '../../../../../src/shared/native-chat/input/native-chat-activity'
import { MobileNativeChatActivityBar } from './MobileNativeChatActivityBar'
import { subagentRowSwipeDismisses } from './MobileNativeChatSubagentSheet'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Animated: {
    Value: class {
      setValue(): void {}
    },
    View: 'AnimatedView',
    spring: () => ({ start(): void {} })
  },
  PanResponder: { create: () => ({ panHandlers: {} }) }
}))

vi.mock('lucide-react-native', () => ({
  Ban: 'Ban',
  ChevronLeft: 'ChevronLeft',
  ListChecks: 'ListChecks',
  Users: 'Users',
  X: 'X'
}))

vi.mock('../../../components/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
    visible ? createElement('BottomDrawer', null, children) : null
}))

vi.mock('./MobileNativeChatTaskList', () => ({
  MobileNativeChatTaskList: () => null
}))

const stored = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      stored.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      stored.delete(key)
    })
  }
}))

function agent(
  id: string,
  label: string,
  state: NativeChatSubagentActivity['state']
): NativeChatSubagentActivity {
  return { id, label, state, activity: null }
}

const roster = [
  agent('run', 'Runner', 'working'),
  agent('bad', 'Checker', 'failed'),
  agent('lost', 'Scout', 'unverifiable')
]

function press(renderer: ReactTestRenderer, testID: string): void {
  const node = renderer.root.findAll((entry) => entry.props.testID === testID)[0]
  if (!node) {
    throw new Error(`missing ${testID}`)
  }
  act(() => {
    node.props.onPress()
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  stored.clear()
})

it('treats a horizontal swipe past the threshold as a dismiss', () => {
  expect(subagentRowSwipeDismisses(-72, 4)).toBe(true)
  expect(subagentRowSwipeDismisses(80, 10)).toBe(true)
  expect(subagentRowSwipeDismisses(-40, 2)).toBe(false)
  expect(subagentRowSwipeDismisses(-80, 90)).toBe(false)
})

it('dismisses failed rows, hides the pill when none remain, and keeps the dismissal', async () => {
  let renderer: ReactTestRenderer
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatActivityBar, {
        list: null,
        subagents: roster,
        focused: null,
        focusedTranscriptEmpty: false,
        fontScale: 1,
        onFocusSubagent: () => {},
        dismissalScope: { hostId: 'host-1', worktreeId: 'wt-1', sessionId: 'sess' }
      })
    )
  })
  await settle()
  press(renderer!, 'native-chat-subagents-pill')
  const dismissals = renderer!.root.findAll(
    (entry) => entry.props.testID === 'native-chat-dismiss-subagent'
  )
  expect(dismissals).toHaveLength(2)
  expect(
    renderer!.root.findAll((entry) => entry.props.testID === 'native-chat-dismiss-all-failed')
  ).toHaveLength(1)
  const checker = dismissals.find((entry) => entry.props.accessibilityLabel === 'Dismiss Checker')
  expect(checker).toBeTruthy()
  await act(async () => {
    checker?.props.onPress()
  })
  await settle()
  expect(
    renderer!.root.findAll((entry) => entry.props.accessibilityLabel === 'Dismiss Checker')
  ).toHaveLength(0)
  expect(
    renderer!.root.findAll((entry) => entry.props.testID === 'native-chat-dismiss-all-failed')
  ).toHaveLength(0)

  renderer!.unmount()
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatActivityBar, {
        list: null,
        subagents: roster,
        focused: null,
        focusedTranscriptEmpty: false,
        fontScale: 1,
        onFocusSubagent: () => {},
        dismissalScope: { hostId: 'host-1', worktreeId: 'wt-1', sessionId: 'sess' }
      })
    )
  })
  await settle()
  press(renderer!, 'native-chat-subagents-pill')
  expect(
    renderer!.root.findAll((entry) => entry.props.accessibilityLabel === 'Dismiss Checker')
  ).toHaveLength(0)
  expect(
    renderer!.root.findAll((entry) => entry.props.accessibilityLabel === 'Dismiss Scout')
  ).toHaveLength(1)
})

it('lists completed children only after the sheet is open and the section is expanded', async () => {
  const onFocusSubagent = vi.fn()
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatActivityBar, {
        list: null,
        subagents: [...roster, agent('done', 'Greeter', 'completed')],
        focused: null,
        focusedTranscriptEmpty: false,
        fontScale: 1,
        onFocusSubagent
      })
    )
  })
  expect(renderer.root.findAll((entry) => entry.props.children === '1 subagent').length).toBe(0)
  expect(
    renderer.root.findAll((entry) => entry.props.children === '3 subagents').length
  ).toBeGreaterThan(0)
  press(renderer, 'native-chat-subagents-pill')
  const section = renderer.root.find(
    (entry) => entry.props.testID === 'native-chat-completed-subagents'
  )
  expect(renderer.root.findAll((entry) => entry.props.children === 'Greeter')).toHaveLength(0)
  await act(async () => {
    section.props.onPress()
  })
  expect(
    renderer.root.findAll((entry) => entry.props.children === 'Greeter').length
  ).toBeGreaterThan(0)
  press(renderer, 'native-chat-open-completed')
  expect(onFocusSubagent).toHaveBeenCalledWith('done')
})

it('hides the pill after every failed child is dismissed', async () => {
  const failed = [agent('bad', 'Checker', 'failed'), agent('lost', 'Scout', 'unverifiable')]
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatActivityBar, {
        list: null,
        subagents: failed,
        focused: null,
        focusedTranscriptEmpty: false,
        fontScale: 1,
        onFocusSubagent: () => {}
      })
    )
  })
  press(renderer, 'native-chat-subagents-pill')
  const dismissAll = renderer.root.find(
    (entry) => entry.props.testID === 'native-chat-dismiss-all-failed'
  )
  await act(async () => {
    dismissAll.props.onPress()
  })
  expect(
    renderer.root.findAll((entry) => entry.props.testID === 'native-chat-subagents-pill')
  ).toHaveLength(0)
})
