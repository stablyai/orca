import { describe, expect, it, vi } from 'vitest'
import {
  installChatViewHooks,
  hostType,
  render,
  root,
  update
} from './MobileNativeChatView.harness.test-fixture'

vi.mock('react-native', async () => {
  const { reactNativeStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return reactNativeStub()
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
  Square: 'Square'
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
vi.mock('./native-chat/composer/MobileNativeChatComposer', async () => {
  const { composerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return composerStub()
})

describe('MobileNativeChatView: Stop control', () => {
  installChatViewHooks()

  it("holds Stop and says Stopping while this phone's own Stop request is in flight", async () => {
    await render({
      structuredActivityUi: true,
      agentWorking: true,
      canStop: true,
      turnIndicator: {
        thinking: false,
        activityText: null,
        stopping: true,
        stopRequestInFlight: true
      }
    })
    const stop = root().find(
      (node) => hostType(node) === 'Pressable' && node.props.accessibilityLabel === 'Stopping…'
    )
    expect(stop.props.disabled).toBe(true)
  })

  it.each([
    ['queue', 'Queue a message to run after the stop'],
    ['send', 'Send a message to run after the stop']
  ] as const)(
    'tells the composer a message sent now runs after the stop (%s)',
    async (afterStop, placeholder) => {
      await render({
        structuredActivityUi: true,
        agentWorking: true,
        canStop: true,
        turnIndicator: { thinking: false, activityText: null, stopping: true, afterStop }
      })
      const composer = root().find((node) => hostType(node) === 'Composer')
      expect(composer.props.placeholder).toBe(placeholder)
    }
  )

  it('keeps Stop for the repeat that escalates while the host alone says Stopping', async () => {
    await render({
      structuredActivityUi: true,
      agentWorking: true,
      canStop: true,
      turnIndicator: { thinking: false, activityText: null, stopping: true }
    })
    const stop = root().find(
      (node) => hostType(node) === 'Pressable' && node.props.accessibilityLabel === 'Stop the agent'
    )
    expect(stop.props.disabled).toBe(false)
  })

  it('keeps Stop hidden during a structured dispatch until a provider turn can be cancelled', async () => {
    const props = { structuredActivityUi: true, agentWorking: true, canStop: false }
    await render(props)
    const stops = () => root().findAll((node) => node.props.accessibilityLabel === 'Stop the agent')
    expect(stops()).toHaveLength(0)
    await update({ ...props, canStop: true })
    expect(stops()).toHaveLength(1)
    await update({ agentWorking: true })
    expect(stops()).toHaveLength(1)
  })
})

vi.mock('./MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))
