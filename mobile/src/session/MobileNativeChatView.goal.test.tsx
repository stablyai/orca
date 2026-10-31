import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  installChatViewHooks,
  render,
  root,
  update,
  hostType
} from './MobileNativeChatView.harness.test-fixture'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import type { MobileNativeChatThreadGoal } from './use-mobile-native-chat-session'

vi.mock('../hooks/use-now', () => ({ useNow: () => 200_000 }))
vi.mock('../platform/media-picker', () => ({
  useMediaPicker: () => ({
    pickImage: () => {
      throw new Error('Unexpected media picker use in a goal render')
    },
    pickImages: () => {
      throw new Error('Unexpected media picker use in a goal render')
    },
    pickFiles: () => {
      throw new Error('Unexpected media picker use in a goal render')
    }
  })
}))
vi.mock('react-native', async () => {
  const { reactNativeStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return {
    ...(await reactNativeStub()),
    useWindowDimensions: () => ({ width: 800, height: 360 })
  }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', async () => {
  const { gestureHandlerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return gestureHandlerStub()
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square',
  Goal: 'Goal',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Pause: 'Pause',
  Play: 'Play',
  Trash2: 'Trash2'
}))
vi.mock('./native-chat/transcript/MobileNativeChatMessage', () => ({
  MobileNativeChatMessage: 'ChatMessage'
}))
vi.mock('./native-chat/transcript/MobileNativeChatLiveLine', () => ({
  MobileNativeChatLiveLine: 'LiveStatus'
}))
vi.mock('./native-chat/input/MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./native-chat/input/MobileNativeChatPermission', () => ({
  MobileNativeChatPermission: 'ChatPermission'
}))
vi.mock('./native-chat/input/MobileNativeChatQuestion', () => ({
  MobileNativeChatQuestion: 'ChatQuestion'
}))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./native-chat/input/MobileNativeChatPromptCard', () => ({
  MobileNativeChatPromptCard: 'PromptCard'
}))
vi.mock('./native-chat/composer/MobileNativeChatComposer', async () => {
  const { composerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return composerStub()
})

describe('mobile goal banner', () => {
  installChatViewHooks()
  const threadGoal: MobileNativeChatThreadGoal = {
    goal: {
      objective: 'Keep the full objective visible on the phone',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 500,
      timeUsedSeconds: 67,
      createdAt: 1_000,
      updatedAt: 10_000
    },
    runningTurn: { startedAt: 20_000 },
    hostClockOffsetMs: 170_000
  }
  const texts = () =>
    root()
      .findAll((node) => hostType(node) === 'Text')
      .flatMap((node) =>
        typeof node.props.children === 'string'
          ? [node.props.children]
          : Array.isArray(node.props.children)
            ? node.props.children.filter((x: unknown) => typeof x === 'string')
            : []
      )

  it('renders goal text and host-clock elapsed time above the composer, with full text on tap', async () => {
    await render({ threadGoal })
    expect(texts()).toContain(threadGoal.goal.objective)
    expect(texts().join('')).toContain('Pursuing goal')
    expect(texts()).toContain('1m 17s')
    const banner = root().findByProps({ testID: 'thread-goal-banner' })
    const button = banner.find((node) => hostType(node) === 'Pressable')
    expect(button.props.accessibilityState.expanded).toBe(false)
    expect(button.props.accessibilityLabel).toContain('1m 17s')
    await act(async () => button.props.onPress())
    expect(button.props.accessibilityState.expanded).toBe(true)
    expect(button.props.accessibilityLabel).toContain('Hide full goal')
  })

  it('opens a long goal outside the chat layout in the existing scrollable drawer', async () => {
    const objective = 'A multi-paragraph objective that must stay readable.\n\n'.repeat(40)
    await render({
      threadGoal: { ...threadGoal, goal: { ...threadGoal.goal, objective } },
      keyboardInset: 240
    })
    const banner = root().findByProps({ testID: 'thread-goal-banner' })
    const button = banner.find((node) => hostType(node) === 'Pressable')
    expect(root().findAll((node) => hostType(node) === 'GoalDrawer')).toHaveLength(0)
    await act(async () => button.props.onPress())
    const drawer = root().find((node) => hostType(node) === 'GoalDrawer')
    expect(drawer.props.contentScrollable).not.toBe(false)
    expect(drawer.props.fillAvailable).toBe(true)
    const full = drawer.find(
      (node) => hostType(node) === 'Text' && node.props.children === objective
    )
    expect(full.props.numberOfLines).toBeUndefined()
    expect(drawer.findAll((node) => hostType(node) === 'Composer')).toHaveLength(0)
    expect(root().findAll((node) => hostType(node) === 'Composer')).toHaveLength(1)
    expect(
      button
        .findAll((node) => hostType(node) === 'Text')
        .some((node) => node.props.numberOfLines === 1)
    ).toBe(true)
    await act(async () => drawer.props.onClose())
    expect(root().findAll((node) => hostType(node) === 'GoalDrawer')).toHaveLength(0)
    expect(button.props.accessibilityState.expanded).toBe(false)
  })

  it('uses the selected phone language for goal status and accessible actions', async () => {
    await act(async () => activateMobileUiLocale('zh'))
    try {
      await render({ threadGoal })
      expect(texts().join('')).toContain('正在追求目标')
      const button = root()
        .findByProps({ testID: 'thread-goal-banner' })
        .find((node) => hostType(node) === 'Pressable')
      expect(button.props.accessibilityLabel).toContain('显示完整目标')
      await act(async () => button.props.onPress())
      expect(button.props.accessibilityLabel).toContain('隐藏完整目标')
      await act(async () => activateMobileUiLocale('ja'))
      for (const status of ['budgetLimited', 'usageLimited'] as const) {
        await update({ threadGoal: { ...threadGoal, goal: { ...threadGoal.goal, status } } })
        expect(texts().join('')).toContain('目標が上限に達しました')
      }
    } finally {
      await act(async () => activateMobileUiLocale('en'))
    }
  })

  it('keeps an idle goal set, renders paused/blocked/limited goals, and hides completed or cleared goals', async () => {
    await render({ threadGoal: null })
    for (const [status, label] of [
      ['active', 'Goal set'],
      ['paused', 'Paused goal'],
      ['blocked', 'Goal blocked'],
      ['budgetLimited', 'Goal limited'],
      ['usageLimited', 'Goal limited']
    ] as const) {
      await update({
        threadGoal: { ...threadGoal, goal: { ...threadGoal.goal, status }, runningTurn: null }
      })
      expect(texts().join('')).toContain(label)
      expect(texts()).toContain('1m 7s')
    }
    await update({
      threadGoal: { ...threadGoal, goal: { ...threadGoal.goal, status: 'complete' } }
    })
    expect(root().findAllByProps({ testID: 'thread-goal-banner' })).toHaveLength(0)
    await update({ threadGoal: null })
    expect(root().findAllByProps({ testID: 'thread-goal-banner' })).toHaveLength(0)
  })

  it('offers clear and status-appropriate controls in the full-goal drawer', async () => {
    const change = vi.fn(async () => true)
    const controls = { pending: false, disabled: false, change }
    await render({ threadGoal: { ...threadGoal, controls } })
    const expand = root()
      .findByProps({ testID: 'thread-goal-banner' })
      .find((node) => hostType(node) === 'Pressable')
    await act(async () => expand.props.onPress())
    const action = (label: string) =>
      root().find(
        (node) => hostType(node) === 'Pressable' && node.props.accessibilityLabel === label
      )
    await act(async () => action('Pause goal').props.onPress())
    expect(change).toHaveBeenLastCalledWith({ kind: 'status', status: 'paused' })
    expect(texts()).toContain(threadGoal.goal.objective)
    await update({
      threadGoal: { ...threadGoal, goal: { ...threadGoal.goal, status: 'paused' }, controls }
    })
    await act(async () => action('Resume goal').props.onPress())
    expect(change).toHaveBeenLastCalledWith({ kind: 'status', status: 'active' })
    await act(async () => action('Clear goal').props.onPress())
    expect(change).toHaveBeenLastCalledWith({ kind: 'clear' })
    await update({
      threadGoal: {
        ...threadGoal,
        goal: { ...threadGoal.goal, status: 'budgetLimited' },
        controls: { ...controls, pending: true }
      }
    })
    expect(
      root().findAll(
        (node) => hostType(node) === 'Pressable' && node.props.accessibilityLabel === 'Resume goal'
      )
    ).toHaveLength(0)
    expect(action('Clear goal').props.disabled).toBe(true)
    await act(async () => activateMobileUiLocale('zh'))
    try {
      await update({ threadGoal: { ...threadGoal, controls } })
      expect(action('清除目标').props.disabled).toBe(false)
      expect(action('暂停目标').props.disabled).toBe(false)
    } finally {
      await act(async () => activateMobileUiLocale('en'))
    }
    await update({ threadGoal })
    expect(
      root().findAll(
        (node) => hostType(node) === 'Pressable' && node.props.accessibilityLabel === 'Clear goal'
      )
    ).toHaveLength(0)
  })
})
