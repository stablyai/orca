import { describe, expect, it, vi } from 'vitest'
import {
  installChatViewHooks,
  assistantTurn,
  banners,
  bannerText,
  hostType,
  listIds,
  pressSend,
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

  it('leaves only the words of a read that failed for good, over a loaded transcript', async () => {
    const loaded = [assistantTurn('m1', 'earlier reply')]
    const words = 'This chat was saved by a newer Orca. Update Orca to open it.'
    const shown = (text: string) =>
      root().findAll((node) => hostType(node) === 'Text' && node.props.children === text)
    const composers = () => root().findAll((node) => hostType(node) === 'Composer')
    const lists = () => root().findAll((node) => hostType(node) === 'FlatList')
    const failure = {
      messages: loaded,
      folded: loaded,
      status: 'error' as const,
      error: words,
      canStop: true,
      permission: { title: 'Approve?', options: [{ label: 'Allow', send: '1' }] },
      sendErrorMessage: 'Message unconfirmed — check chat before retrying'
    }
    await render({ ...failure, readFailedFinally: true })
    expect(shown(words)).toHaveLength(1)
    expect(composers()).toHaveLength(0)
    expect(lists()).toHaveLength(0)
    expect(banners()).toHaveLength(0)
    expect(root().findAllByProps({ accessibilityLabel: 'Stop the agent' })).toHaveLength(0)

    await update({ ...failure, error: "Orca couldn't open this chat's history right now." })
    expect(listIds()).toEqual(['m1'])
    expect(composers()).toHaveLength(1)
    expect(banners()).toHaveLength(1)
  })

  it('retires the previous route banner when a new send starts', async () => {
    const onClearSendError = vi.fn()
    await render({
      onSend: vi.fn().mockResolvedValue(false),
      inputLockReason: 'disconnected',
      sendErrorMessage: 'Stop failed',
      onClearSendError
    })
    await pressSend()

    expect(onClearSendError).toHaveBeenCalledOnce()
    expect(banners()).toHaveLength(1)
    expect(bannerText()).toBe('Stop failed')
  })

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

vi.mock('../MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))
