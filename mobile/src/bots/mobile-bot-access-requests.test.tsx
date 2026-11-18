import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Icon',
  ChevronRight: 'Icon',
  ChevronDown: 'Icon',
  ChevronLeft: 'Icon'
}))
vi.mock('../components/list/DisclosureChevron', () => ({
  DisclosureChevron: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../platform/haptics/haptics', () => ({ triggerSelection: () => {} }))
vi.mock('../components/controls/MobileSwitch', () => ({ MobileSwitch: () => null }))
vi.mock('../components/bottom-drawer/BottomDrawer', () => ({ BottomDrawer: () => null }))

vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))

import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { accessGrantConfirmCopy } from './bot-access-request-copy'
import { decideBotAccessRequest } from './bot-access-request-operations'
import { MobileBotSettingsTab } from './MobileBotSettingsTab'
import type { BotAccessRequests } from './use-bot-access-requests'
import type { RouteBot } from './use-route-bot'

const request: ConnectorAccessRequest = {
  requestId: 'req-1',
  botId: 'bot-1',
  source: 'slack',
  workspaceId: 'T1',
  workspaceName: 'Acme',
  requester: { id: 'U9', name: 'Dana Kim', handle: 'dana', detail: 'Dana Kim' },
  createdAt: 1,
  expiresAt: 2
}

const routeBot: RouteBot = {
  bot: {
    id: 'bot-1',
    name: 'Reviewer',
    folderWorkspaceId: 'fw-1',
    avatar: null,
    paused: false,
    agent: 'claude',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null
  },
  avatar: { kind: 'mascot', id: 'A1' },
  activity: null,
  listStatus: null,
  needsYou: 0,
  applyBot: () => {},
  refresh: () => {},
  reads: 0,
  itemReads: 0
}

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

function renderTab(
  access: BotAccessRequests | null,
  options: { bot?: RouteBot['bot']; client?: RpcClient } = {}
) {
  act(() => {
    tree = create(
      createElement(MobileBotSettingsTab, {
        routeBot: { ...routeBot, bot: options.bot ?? routeBot.bot },
        client: options.client ?? null,
        showToast: () => {},
        accessRequests: access,
        lookAround: null
      })
    )
  })
  return tree!
}

// A row's button by its label; the confirm's by its text.
function press(root: ReactTestInstance, label: string) {
  const [labelled] = root.findAllByProps({ accessibilityLabel: label })
  const target = labelled ?? root.findByProps({ children: label }).parent
  act(() => target?.props.onPress())
}

const texts = (root: ReactTestInstance) =>
  root
    .findAll((node) => typeof node.props.children === 'string')
    .map((node) => String(node.props.children))

describe('access requests in the bot sheet', () => {
  it('asks with the desktop’s confirm before Give access, and grants through the host', () => {
    const decide = vi.fn(async () => {})
    const root = renderTab({ requests: [request], deciding: false, decide }).root

    expect(texts(root)).toContain('Asking for access')
    expect(texts(root)).toContain('@dana · Slack (Acme)')
    press(root, 'Review Dana Kim')
    expect(decide).not.toHaveBeenCalled()
    expect(texts(root)).toContain('Give Dana Kim access to Reviewer?')

    press(root, 'Give access')
    expect(decide).toHaveBeenCalledExactlyOnceWith(request, 'granted')
  })

  it('declines without asking, as the desktop does', () => {
    const decide = vi.fn(async () => {})
    const root = renderTab({ requests: [request], deciding: false, decide }).root

    press(root, 'Decline Dana Kim')

    expect(decide).toHaveBeenCalledExactlyOnceWith(request, 'declined')
  })

  it('shows no section on a host without access requests', () => {
    expect(texts(renderTab(null).root)).not.toContain('Asking for access')
  })
})

function client(reply: RpcResponse | Error, sent: unknown[] = []): RpcClient {
  return {
    sendRequest: (method: string, params: unknown) => {
      sent.push({ method, params })
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: (): ConnectionState => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

describe('who can ask in the bot sheet', () => {
  const members = [
    { id: 'U1', name: 'Sam', source: 'slack' },
    { id: 'L1', name: 'Bea', source: 'linear', workspaceId: 'org-1' }
  ]
  const shared = { ...routeBot.bot, permissionMode: 'full-access' as const, members }

  it('asks before Keep only me, then removes each person on the host', async () => {
    const sent: { method: string; params: unknown }[] = []
    const ok: RpcResponse = { id: 'u', ok: true, result: { bot: routeBot.bot } }
    const root = renderTab(null, { bot: shared, client: client(ok, sent) }).root
    const updates = () => sent.filter((entry) => entry.method === 'bots.update')

    expect(texts(root)).toContain('You, Sam and Bea can ask Reviewer.')
    press(root, 'Keep only me')
    expect(texts(root)).toContain('Keep Reviewer to yourself?')
    press(root, 'Cancel')
    expect(updates()).toEqual([])

    press(root, 'Keep only me')
    await act(async () => press(root, 'Keep only me'))
    expect(updates().map((entry) => entry.params)).toEqual([
      { botId: 'bot-1', updates: { removeMember: { id: 'U1', source: 'slack' } } },
      {
        botId: 'bot-1',
        updates: { removeMember: { id: 'L1', source: 'linear', workspaceId: 'org-1' } }
      }
    ])
  })

  it('names whoever Keep only me couldn’t remove', async () => {
    const showToast = vi.fn()
    act(() => {
      tree = create(
        createElement(MobileBotSettingsTab, {
          routeBot: { ...routeBot, bot: shared },
          client: client(new Error('closed')),
          showToast,
          accessRequests: null,
          lookAround: null
        })
      )
    })
    press(tree!.root, 'Keep only me')
    await act(async () => press(tree!.root, 'Keep only me'))
    expect(showToast).toHaveBeenCalledExactlyOnceWith('Couldn’t remove Sam, Bea. Try again.', 2400)
  })

  it('asks before starting new conversations in Ask for approval', async () => {
    const sent: { method: string; params: unknown }[] = []
    const ok: RpcResponse = { id: 'u', ok: true, result: { bot: routeBot.bot } }
    const root = renderTab(null, { bot: shared, client: client(ok, sent) }).root
    press(root, 'Switch')
    expect(texts(root)).toContain('Start new conversations in Ask for approval?')
    await act(async () => press(root, 'Switch'))
    expect(sent.filter((entry) => entry.method === 'bots.update').map((e) => e.params)).toEqual([
      { botId: 'bot-1', updates: { permissionMode: 'ask' } }
    ])
  })

  it('lists what the people who can ask reach, as the desktop does', () => {
    const root = renderTab(null, { bot: { ...shared, google: true } }).root
    expect(texts(root)).toEqual(
      expect.arrayContaining([
        'What Reviewer can reach',
        'Your files, commands and accounts on your computer',
        'New conversations start in Full access',
        'Your Google account, as far as you allowed it when you signed in'
      ])
    )
  })

  it('gives no advice while only the owner can ask', () => {
    const root = renderTab(null).root
    expect(texts(root)).toContain('Only you can ask Reviewer.')
    expect(texts(root)).not.toContain('Before you share')
  })
})

describe('the phone’s grant confirm', () => {
  it('says what the person will reach, even for a bot only its owner can ask yet', () => {
    const { message } = accessGrantConfirmCopy(request, {
      name: 'Reviewer',
      agent: 'codex',
      permissionMode: 'auto'
    })
    const lines = message.split('\n\n')
    expect(lines).toContain(
      'New conversations start in Approve for me. Reviews approval requests for you. Codex uses its configured sandbox. If it asks, whoever asked can approve.'
    )
    expect(
      lines.some((line) => line.startsWith('Your files, commands and accounts on your computer'))
    ).toBe(true)
  })
})

describe('decideBotAccessRequest', () => {
  it('sends the request id and decision, and reads the host’s answer', async () => {
    const sent: unknown[] = []
    const ok: RpcResponse = { id: 'd', ok: true, result: { ok: true } }
    await expect(decideBotAccessRequest(client(ok, sent), 'req-1', 'granted')).resolves.toEqual({
      ok: true
    })
    expect(sent).toEqual([
      { method: 'bots.access.decide', params: { requestId: 'req-1', decision: 'granted' } }
    ])
    const refused: RpcResponse = { id: 'd', ok: true, result: { ok: false, error: 'expired' } }
    await expect(decideBotAccessRequest(client(refused), 'req-1', 'granted')).resolves.toEqual({
      ok: false,
      error: 'expired'
    })
    await expect(
      decideBotAccessRequest(client(new Error('closed')), 'req-1', 'declined')
    ).resolves.toEqual({ ok: false, error: 'failed' })
  })
})
