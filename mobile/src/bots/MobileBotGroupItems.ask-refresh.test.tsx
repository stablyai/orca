import { createElement, useCallback, useState, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTestBotItem } from '../../../src/shared/bots/bot-item.test-fixture'
import { createFakeRpcClient } from '../mobile-web-shell/test-support/bridge-host-test-fakes'
import { MobileBotGroupItems } from './MobileBotGroupItems'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
  StyleSheet: { create: (x: unknown) => x, hairlineWidth: 1 },
  useColorScheme: () => 'light',
  Appearance: { getColorScheme: () => 'light', addChangeListener: () => ({ remove() {} }) }
}))
vi.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_, name) => String(name), has: () => true })
)
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../hooks/use-now', () => ({ useNow: () => 100 }))
vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => ({}) }))
vi.mock('../components/bottom-drawer/bottom-drawer-modal-host', () => ({
  BottomDrawerModalHost: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children: ReactNode }) => children,
  OptionPager: ({
    pager,
    main,
    page
  }: {
    pager: { page: string | null }
    main: ReactNode
    page: ReactNode
  }) => (pager.page ? page : main),
  useOptionPager: () => {
    const [page, setPage] = useState<string | null>(null)
    const close = useCallback(() => setPage(null), [])
    return { page, open: setPage, close, forget: close }
  }
}))
vi.mock('../components/nav-bar/SheetHeader', () => ({
  SheetHeader: ({
    trailingButtons,
    trailing
  }: {
    trailingButtons?: ReactNode
    trailing?: { label: string; onPress: () => void }
  }) =>
    createElement(
      'Header',
      {},
      trailingButtons,
      trailing && createElement('Button', { label: trailing.label, onPress: trailing.onPress })
    )
}))
vi.mock('../components/nav-bar/NavBarButton', () => ({
  NavBarButton: (props: { accessibilityLabel: string; onPress: () => void; active?: boolean }) =>
    createElement('Button', props)
}))
vi.mock('../components/feedback/TransientToast', () => ({
  TransientToast: () => null,
  useTransientToast: () => ({ message: null, showToast: () => {} })
}))
vi.mock('../components/feedback/MobileStateView', () => ({
  MobileNoMatchState: ({ message }: { message: string }) => createElement('Text', {}, message),
  MobileStateView: ({ title }: { title: string }) => createElement('Text', {}, title),
  MobileLoadErrorState: () => null,
  MobileOfflineState: () => null
}))
vi.mock('../components/list/ListGroup', () => ({
  ListGroup: ({ children }: { children: ReactNode }) => children,
  ListRow: ({ title, accessory }: { title: string; accessory?: ReactNode }) =>
    createElement('Row', {}, title, accessory),
  SectionHeader: () => null,
  LIST_ROW_PADDING: 12
}))
vi.mock('../components/controls/MobileSwitch', () => ({
  MobileSwitch: ({ onValueChange }: { onValueChange: (value: boolean) => void }) =>
    createElement('Switch', { onValueChange, accessibilityLabel: 'Needs you only' })
}))
vi.mock('./MobileBotAvatar', () => ({ MobileBotAvatar: () => null }))
vi.mock('./items/MobileBotItemsTab', () => ({
  ReadFailed: ({ onRetry }: { onRetry: () => void }) =>
    createElement('Button', { label: 'Retry', onPress: onRetry }),
  ItemGroup: () => null
}))
vi.mock('./items/MobileBotNeedsYouGroup', () => ({
  MobileBotNeedsYouGroup: ({ asks }: { asks: { title: string }[] }) =>
    createElement('Asks', {}, asks.map((ask) => ask.title).join(','))
}))
vi.mock('./items/MobileBotItemRow', () => ({ MobileBotItemRow: () => null }))
vi.mock('./items/MobileBotItemPage', () => ({ MobileBotItemPage: () => null }))
vi.mock('./items/MobileBotItemSheets', () => ({ MobileBotItemSheets: () => null }))
vi.mock('../session/native-chat/input/prompts/use-mobile-paired-server-asks', () => ({
  useMobilePairedServerAsks: () => ({ open: [] })
}))
vi.mock('./connectors/phone-connector-needs', () => ({ usePhoneConnectorNeeds: () => [] }))
vi.mock('./items/use-phone-chat-prompts', () => {
  const noPrompt = () => undefined
  return { useChatPrompts: () => noPrompt }
})
vi.mock('./items/use-bot-item-moves', () => ({
  useBotItemMoves: () => ({ move() {}, snooze() {} })
}))
vi.mock('./items/use-phone-bot-item-walk', () => ({
  usePhoneBotItemWalk: () => ({ shown: () => null, open() {} })
}))
vi.mock('./use-mobile-bot-group-item-openers', () => ({
  useMobileBotGroupItemOpeners: () => ({ chat() {}, worker() {} })
}))
vi.mock('./items/bot-item-file-open', () => ({ openBotItemFile() {} }))

let renderer: ReactTestRenderer
const client = createFakeRpcClient()
const bot = {
  id: 'bot-a',
  name: 'Example agent',
  hostId: 'local',
  folder: 'example',
  folderWorkspaceId: 'fixture',
  agent: 'codex',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null
}
const group = {
  id: 'group',
  name: 'Example group',
  hostId: 'local',
  revision: 1,
  folder: 'fixture',
  folderWorkspaceId: 'fixture',
  createdAt: 1,
  members: [{ botId: 'bot-a', sessionId: 'room' }],
  replyMode: { kind: 'mentions' }
}
const planned = makeTestBotItem(1, { status: 'planned' })
let askNotice = 0
const reads = () => ({ rooms: 0, all: 0, bots: {}, asks: { all: askNotice, bots: {} } })
const props = () => ({
  visible: true,
  onClose() {},
  client,
  groupId: 'group',
  hostId: 'local',
  bots: [bot],
  reads: reads(),
  memberIds: { current: [] },
  online: true,
  hostName: 'Example host',
  onOpenRoom() {}
})
const response = (result: unknown) => ({ id: '1', ok: true as const, result })
const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
const request = (method: string) => client.requests.findLast((item) => item.method === method)!
const text = () => JSON.stringify(renderer.toJSON())
const tree = (chats: unknown[] = []) => ({ chats, workspaceChats: {} })
afterEach(() => {
  act(() => renderer?.unmount())
  client.requests.length = 0
  askNotice = 0
})

it('withholds the drawer empty claim until the ask refresh succeeds, and Retry recovers it', async () => {
  await act(async () => {
    renderer = create(createElement(MobileBotGroupItems, props()))
  })
  await act(async () => {
    request('bots.groups.list').resolve(response({ groups: [group] }))
  })
  await flush()
  await act(async () => {
    request('bots.items.owner.list').resolve(
      response({ items: [planned], counts: {}, seenEventId: 'e10' })
    )
    request('bots.chatTree').resolve(response(tree()))
  })
  await flush()
  expect(text()).toContain('Nothing needs you')
  act(() => renderer.root.findByProps({ accessibilityLabel: 'Filter items' }).props.onPress())
  act(() =>
    renderer.root.findByProps({ accessibilityLabel: 'Needs you only' }).props.onValueChange(true)
  )
  act(() => renderer.root.findByProps({ label: 'Done' }).props.onPress())
  expect(text()).toContain('Nothing needs you.')
  askNotice = 1
  await act(async () => {
    renderer.update(createElement(MobileBotGroupItems, props()))
  })
  expect(text()).not.toContain('Nothing needs you.')
  act(() => renderer.root.findByProps({ accessibilityLabel: 'Filter items' }).props.onPress())
  act(() =>
    renderer.root.findByProps({ accessibilityLabel: 'Needs you only' }).props.onValueChange(false)
  )
  act(() => renderer.root.findByProps({ label: 'Done' }).props.onPress())
  expect(text()).not.toContain('Nothing needs you')
  act(() => renderer.root.findByProps({ accessibilityLabel: 'Filter items' }).props.onPress())
  act(() =>
    renderer.root.findByProps({ accessibilityLabel: 'Needs you only' }).props.onValueChange(true)
  )
  act(() => renderer.root.findByProps({ label: 'Done' }).props.onPress())
  await act(async () => {
    request('bots.chatTree').resolve({
      id: '1',
      ok: false,
      error: { code: 'unavailable', message: 'offline' }
    })
  })
  await flush()
  expect(text()).not.toContain('Nothing needs you.')
  act(() => renderer.root.findByProps({ label: 'Retry' }).props.onPress())
  await flush()
  await act(async () => {
    request('bots.groups.list').resolve(response({ groups: [group] }))
    request('bots.items.owner.list').resolve(
      response({ items: [planned], counts: {}, seenEventId: 'e10' })
    )
    request('bots.chatTree').resolve(
      response(
        tree([
          {
            chatId: 'example-chat',
            title: 'Example question',
            origin: 'side',
            live: 'needs-you',
            lastActiveAt: 1,
            unread: false,
            closed: false,
            running: [],
            runningTotal: 0,
            finished: [],
            finishedTotal: 0,
            failedTotal: 0
          }
        ])
      )
    )
  })
  await flush()
  expect(text()).toContain('Example question')
  expect(text()).not.toContain('Nothing needs you.')
})
