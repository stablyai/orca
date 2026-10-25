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
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileNativeChatComposer', async () => {
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

  it('renders the route-reported failure verbatim', async () => {
    await render({ sendErrorMessage: 'Permission reply failed' })

    expect(banners()).toHaveLength(1)
    expect(bannerText()).toBe('Permission reply failed')
  })

  it('does not duplicate the route banner when the composer rejects', async () => {
    const onClearSendError = vi.fn()
    await render({
      onSend: vi.fn().mockResolvedValue(false),
      inputLockReason: 'disconnected',
      sendErrorMessage: 'Stop failed',
      onClearSendError
    })
    await pressSend()

    expect(onClearSendError).not.toHaveBeenCalled()
    expect(banners()).toHaveLength(1)
    expect(bannerText()).toBe('Stop failed')
  })

  it('asks the route to clear its banner once a send is accepted', async () => {
    const onClearSendError = vi.fn()
    await render({ sendErrorMessage: 'Stop failed', onClearSendError })

    await pressSend()

    expect(onClearSendError).toHaveBeenCalledOnce()
  })
})
