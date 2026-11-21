import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotUpNext } from '../../../src/shared/bots/bot-look-around'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  start: vi.fn(),
  dismiss: vi.fn(),
  lookNow: vi.fn(),
  seen: vi.fn(),
  openLink: vi.fn()
}))

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ArrowUpRight: 'Icon',
  Check: 'Icon',
  ChevronLeft: 'Icon',
  ChevronRight: 'Icon',
  Laptop: 'Icon',
  Mail: 'Icon',
  ShieldAlert: 'Icon',
  ShieldOff: 'Icon'
}))
vi.mock('../components/list/DisclosureChevron', () => ({
  DisclosureChevron: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../platform/haptics/haptics', () => ({ triggerSelection: () => {} }))
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }))
vi.mock('../components/bottom-drawer/BottomDrawer', () => ({ BottomDrawer: () => null }))
vi.mock('../components/controls/MobileSwitch', () => ({ MobileSwitch: 'MobileSwitch' }))
vi.mock('../components/composer-input/TextField', () => ({
  TextField: 'TextField'
}))
vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../platform/media-picking/media-picker', () => ({ useMediaPicker: () => ({}) }))
vi.mock('./MobileBotAvatar', () => ({ MobileBotAvatar: () => null }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('../platform/external-links/external-link', () => ({
  openExternalLink: mocks.openLink
}))
vi.mock('./bot-sheet-operations', () => ({
  botUpdate: { request: mocks.update, interpret: (reply: unknown) => reply }
}))
vi.mock('./tools/bot-tool-operations', () => ({
  botToolsListRead: { request: async () => ({}), interpret: () => ({ own: [], inherited: [] }) }
}))
vi.mock('./bot-up-next-operations', () => ({
  suggestionStart: {
    request: mocks.start,
    interpret: (reply: unknown) => reply
  },
  suggestionDismiss: {
    request: mocks.dismiss,
    interpret: (reply: unknown) => reply
  },
  lookAroundNow: {
    request: mocks.lookNow,
    interpret: (reply: unknown) => reply
  },
  upNextSeen: { request: mocks.seen }
}))

import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileBotSettingsTab } from './MobileBotSettingsTab'
import { MobileBotUpNext, type UpNextActions } from './MobileBotUpNext'
import { useBotUpNext } from './use-bot-up-next'
import type { RouteBot } from './use-route-bot'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked operations never touch the client; Settings reads its state.
const client = {
  getState: () => 'connected',
  onStateChange: () => () => {},
  getLastConnectedAt: () => 1
} as unknown as RpcClient

const bot: RouteBot['bot'] = {
  id: 'bot-1',
  name: 'Scout',
  folderWorkspaceId: 'fw-1',
  avatar: null,
  paused: false,
  agent: 'claude',
  notifications: {
    needsPermission: true,
    taskComplete: true,
    couldNotFinish: true
  },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null
}

const routeBot: RouteBot = {
  bot,
  avatar: { kind: 'mascot', id: 'A1' },
  activity: null,
  listStatus: null,
  needsYou: 0,
  applyBot: () => {},
  refresh: () => {},
  reads: 0,
  itemReads: 0
}

const suggestion = (id: string, title: string) => ({
  id,
  title,
  why: 'Asked for you',
  ask: `Do ${title}`,
  createdAt: 1
})

let tree: ReactTestRenderer | null = null

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.update.mockResolvedValue({ bot })
})

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

function render(element: ReturnType<typeof createElement>): ReactTestInstance {
  act(() => {
    tree = create(element)
  })
  return tree!.root
}

const texts = (root: ReactTestInstance) =>
  root
    .findAll((node) => typeof node.props.children === 'string')
    .map((node) => String(node.props.children))

function press(root: ReactTestInstance, label: string) {
  const [labelled] = root.findAllByProps({ accessibilityLabel: label })
  const target = labelled ?? root.findByProps({ children: label }).parent
  act(() => target?.props.onPress())
}

// Look around is a page of Settings, as on the desktop.
function settings(lookNow = vi.fn()) {
  const root = render(
    createElement(MobileBotSettingsTab, {
      routeBot,
      client,
      showToast: () => {},
      online: true,
      hostName: 'Studio Mac',
      home: { folderPath: '/Users/me/.orca/bots/scout', onDeleted: () => {} },
      accessRequests: null,
      upNext: { lookNow, busy: false }
    })
  )
  press(root, 'Look around, Every 4 hours, 8 AM to 8 PM')
  return root
}

describe('Look around in the phone’s bot Settings', () => {
  it('picks How often on its own page, then returns to Look around', async () => {
    const root = settings()
    press(root, 'How often, Every 4 hours, 8 AM to 8 PM')
    expect(texts(root)).toContain('Each morning at 8 AM')
    await act(async () => press(root, 'Each morning at 8 AM'))
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(
      client,
      {
        botId: 'bot-1',
        updates: { lookAround: { every: 'mornings' } }
      },
      { failWhenDisconnected: true }
    )
    expect(texts(root)).toContain('Last looked')
  })

  it('saves what to look for, trimmed', async () => {
    const root = settings()
    press(root, 'Look for, Anything waiting on you')
    const [field] = root.findAllByProps({ returnKeyType: 'done' })
    act(() => field?.props.onChangeText('  CI on main '))
    await act(async () => press(root, 'Save'))
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(
      client,
      {
        botId: 'bot-1',
        updates: { lookAround: { focus: 'CI on main' } }
      },
      { failWhenDisconnected: true }
    )
  })

  it('asks the host to look now', () => {
    const lookNow = vi.fn()
    press(settings(lookNow), 'Look now')
    expect(lookNow).toHaveBeenCalledOnce()
  })

  it('shows nothing for an agent that does not look around', () => {
    const root = render(
      createElement(MobileBotSettingsTab, {
        routeBot: { ...routeBot, bot: { ...bot, agent: 'grok' } },
        client,
        showToast: () => {},
        online: true,
        hostName: 'Studio Mac',
        home: { folderPath: '/Users/me/.orca/bots/scout', onDeleted: () => {} },
        accessRequests: null,
        upNext: { lookNow: vi.fn(), busy: false }
      })
    )
    expect(texts(root)).not.toContain('Look around')
  })
})

describe('Suggestions on the phone', () => {
  const lookedAt = new Date(2026, 9, 31, 16, 12).getTime()
  const upNext: BotUpNext = {
    state: { running: false, lastLookedAt: lookedAt, seenAt: 0 },
    items: [
      {
        ...suggestion('s1', 'Review #12'),
        link: 'https://github.com/o/r/pull/12',
        source: 'github'
      },
      suggestion('s2', 'Answer Priya'),
      suggestion('s3', 'Fix CI'),
      suggestion('s4', 'Close stale issue')
    ]
  }
  const actions = (start: UpNextActions['start']): UpNextActions => ({
    start,
    dismiss: mocks.dismiss,
    busy: false
  })

  it('starts, dismisses and opens a link', () => {
    const start = vi.fn()
    const root = render(
      createElement(MobileBotUpNext, {
        botName: 'Scout',
        upNext,
        actions: actions(start)
      })
    )
    act(() => root.findAllByProps({ children: 'Start' })[0]?.parent?.props.onPress())
    expect(start).toHaveBeenCalledWith('s1')
    press(root, 'Dismiss Answer Priya')
    expect(mocks.dismiss).toHaveBeenCalledWith('s2')
    act(() => root.findByProps({ accessibilityRole: 'link' }).props.onPress())
    expect(mocks.openLink).toHaveBeenCalledWith('https://github.com/o/r/pull/12')
  })

  it('offers no Start while no chat shows to put it in', () => {
    const root = render(
      createElement(MobileBotUpNext, {
        botName: 'Scout',
        upNext,
        actions: actions(null)
      })
    )
    expect(texts(root)).not.toContain('Start')
  })
})

describe('useBotUpNext', () => {
  type Hook = ReturnType<typeof useBotUpNext>
  function Probe(props: {
    onStart: (ask: string) => void
    refresh: () => void
    out: Hook[]
    upNext?: BotUpNext
    showing?: boolean
  }) {
    props.out[0] = useBotUpNext({
      client,
      botId: 'bot-1',
      upNext: props.upNext,
      showing: props.showing ?? false,
      showToast: () => {},
      onStart: props.onStart,
      refresh: props.refresh,
      online: true
    })
    return null
  }

  it('puts the host’s request in the chat and re-reads the Activity', async () => {
    mocks.start.mockResolvedValue({ ask: 'Review PR #12' })
    const onStart = vi.fn()
    const refresh = vi.fn()
    const out: Hook[] = []
    render(createElement(Probe, { onStart, refresh, out }))
    await act(async () => out[0]?.start?.('s1'))
    expect(mocks.start).toHaveBeenCalledWith(
      client,
      { botId: 'bot-1', suggestionId: 's1' },
      { failWhenDisconnected: true }
    )
    expect(onStart).toHaveBeenCalledWith('Review PR #12')
    expect(refresh).toHaveBeenCalled()
  })

  // Seen on the phone clears the desktop's count and dot, as opening it there does.
  it('marks new suggestions seen while Suggestions shows, and only then', async () => {
    mocks.seen.mockResolvedValue({ seen: true })
    const fresh: BotUpNext = {
      state: { running: false, seenAt: 0 },
      items: [suggestion('s1', 'Review')]
    }
    const out: Hook[] = []
    const props = { onStart: () => {}, refresh: vi.fn(), out, upNext: fresh }
    let root!: ReactTestRenderer
    await act(async () => {
      root = create(createElement(Probe, { ...props, showing: false }))
    })
    expect(mocks.seen).not.toHaveBeenCalled()
    await act(async () => root.update(createElement(Probe, { ...props, showing: true })))
    expect(mocks.seen).toHaveBeenCalledWith(client, { botId: 'bot-1' })
    expect(props.refresh).toHaveBeenCalled()
  })
})
