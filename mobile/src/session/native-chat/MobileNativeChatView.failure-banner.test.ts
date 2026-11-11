import { describe, expect, it, vi } from 'vitest'
import {
  installChatViewHooks,
  bannerText,
  pressSend,
  render,
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
vi.mock('./transcript/MobileNativeChatMessage', () => ({
  MobileNativeChatMessage: 'ChatMessage'
}))
vi.mock('./transcript/MobileNativeChatLiveLine', () => ({
  MobileNativeChatLiveLine: 'LiveStatus'
}))
vi.mock('./input/MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./input/MobileNativeChatPermission', () => ({
  MobileNativeChatPermission: 'ChatPermission'
}))
vi.mock('./input/MobileNativeChatQuestion', () => ({
  MobileNativeChatQuestion: 'ChatQuestion'
}))
vi.mock('../../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./composer/MobileNativeChatComposer', async () => {
  const { composerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return composerStub()
})

describe('MobileNativeChatView: send and read failure banners', () => {
  installChatViewHooks()

  it('retires the previous banner before sending and preserves the new delivery notice', async () => {
    const onClearSendError = vi.fn()
    await render({
      sendErrorMessage: 'Stop failed',
      onClearSendError,
      onSend: async () => {
        expect(onClearSendError).toHaveBeenCalledOnce()
        await update({ sendErrorMessage: 'Delivery unconfirmed' })
        return true
      }
    })

    await pressSend()

    expect(onClearSendError).toHaveBeenCalledOnce()
    expect(bannerText()).toBe('Delivery unconfirmed')
  })
})

vi.mock('./input/MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))
