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
  ChevronLeft: 'Icon',
  Laptop: 'Icon',
  Mail: 'Icon',
  ShieldAlert: 'Icon',
  ShieldOff: 'Icon'
}))
vi.mock('../components/list/DisclosureChevron', () => ({
  DisclosureChevron: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../platform/haptics/haptics', () => ({ triggerSelection: () => {} }))
vi.mock('../components/controls/MobileSwitch', () => ({ MobileSwitch: () => null }))
vi.mock('../components/bottom-drawer/BottomDrawer', () => ({ BottomDrawer: () => null }))

vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../platform/media-picking/media-picker', () => ({ useMediaPicker: () => ({}) }))
vi.mock('./MobileBotAvatar', () => ({ MobileBotAvatar: () => null }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))

import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { decideBotAccessRequest } from './bot-access-request-operations'
import { WorkspaceServerContext } from '../worktree/execution-hosts/workspace-server-context'
import { MobileBotSettingsTab } from './MobileBotSettingsTab'
import { readHostStatusReply } from '../query/host-status-query'
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
  itemReads: 0,
  hostKey: 'host'
}

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

type TabOptions = { bot?: RouteBot['bot']; client?: RpcClient; serverName?: string }
function tabContent(access: BotAccessRequests | null, options: TabOptions = {}) {
  return createElement(
    WorkspaceServerContext.Provider,
    {
      value:
        options.serverName === undefined
          ? undefined
          : {
              client: null,
              state: 'connected',
              desktopCapabilities: [],
              name: options.serverName
            }
    },
    createElement(MobileBotSettingsTab, {
      routeBot: { ...routeBot, bot: options.bot ?? routeBot.bot },
      client: options.client ?? null,
      showToast: () => {},
      online: true,
      hostName: 'Studio Mac',
      home: { folderPath: '/Users/me/.orca/bots/scout', onDeleted: () => {} },
      accessRequests: access,
      upNext: { lookNow: () => {}, busy: false }
    })
  )
}
function renderTab(access: BotAccessRequests | null, options: TabOptions = {}) {
  act(() => {
    tree = create(tabContent(access, options))
  })
  openWhoCanAsk(tree!.root)
  return tree!
}
// Requests and people are on Settings' Who can ask page, as on the desktop.
function openWhoCanAsk(root: ReactTestInstance) {
  const row = root.find(
    (node) =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Who can ask, ') &&
      typeof node.props.onPress === 'function'
  )
  act(() => row.props.onPress())
}
function updateTab(access: BotAccessRequests, direct: RpcClient): ReactTestInstance {
  act(() => tree!.update(tabContent(access, { client: direct })))
  return tree!.root
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
    const root = renderTab({ requests: [request], reads: 1, deciding: false, decide }).root

    press(root, 'Review Dana Kim')
    expect(decide).not.toHaveBeenCalled()

    press(root, 'Give access')
    expect(decide).toHaveBeenCalledExactlyOnceWith(request, 'granted')
  })

  it('keeps an unverified route name out of the warning and grant confirmation', () => {
    const root = renderTab(
      { requests: [request], reads: 1, deciding: false, decide: vi.fn(async () => {}) },
      { serverName: 'Atlas Server' }
    ).root
    expectNamedWarningAndConsent(root, 'the computer this agent runs on')
    expect(texts(root).some((text) => text.includes('Atlas Server'))).toBe(false)
  })

  it('keeps consent neutral when the paired host reports no machine name', async () => {
    const direct = {
      ...client({ id: 'status', ok: true, result: { hostPlatform: 'linux' } }),
      getLastConnectedAt: () => 1
    }
    await readHostStatusReply(direct)
    const root = renderTab(
      { requests: [request], reads: 1, deciding: false, decide: vi.fn(async () => {}) },
      { client: direct }
    ).root
    expectNamedWarningAndConsent(root, 'the computer this agent runs on')
  })

  it('follows the newly paired machine on the same logical client', async () => {
    let generation = 1
    const direct: RpcClient = {
      ...client(machineStatus('Atlas Server')),
      getGeneration: () => generation,
      getLastConnectedAt: () => generation,
      sendRequest: async () => machineStatus(generation === 1 ? 'Atlas Server' : 'Boreal Server')
    }
    await readHostStatusReply(direct)
    const access = {
      requests: [request],
      reads: 1,
      deciding: false,
      decide: vi.fn(async () => {})
    }
    expectNamedWarningAndConsent(renderTab(access, { client: direct }).root, 'Atlas Server')
    generation = 2
    expectNamedWarningAndConsent(updateTab(access, direct), 'the computer this agent runs on')
    await readHostStatusReply(direct)
    expectNamedWarningAndConsent(updateTab(access, direct), 'Boreal Server')
  })

  it('keeps a late response from the previous pairing out of warning and consent', async () => {
    let generation = 1
    let finishOld: (reply: RpcResponse) => void = () => {}
    const oldReply = new Promise<RpcResponse>((resolve) => {
      finishOld = resolve
    })
    const direct: RpcClient = {
      ...client(machineStatus('Boreal Server')),
      getGeneration: () => generation,
      getLastConnectedAt: () => generation,
      sendRequest: () =>
        generation === 1 ? oldReply : Promise.resolve(machineStatus('Boreal Server'))
    }
    const oldRead = readHostStatusReply(direct)
    const access = {
      requests: [request],
      reads: 1,
      deciding: false,
      decide: vi.fn(async () => {})
    }
    renderTab(access, { client: direct })
    generation = 2
    await readHostStatusReply(direct)
    expectNamedWarningAndConsent(updateTab(access, direct), 'Boreal Server')
    finishOld(machineStatus('Atlas Server'))
    await oldRead
    const root = updateTab(access, direct)
    expectNamedWarningAndConsent(root, 'Boreal Server')
    expect(texts(root).some((text) => text.includes('Atlas Server'))).toBe(false)
  })

  it('declines without asking, as the desktop does', () => {
    const decide = vi.fn(async () => {})
    const root = renderTab({ requests: [request], reads: 1, deciding: false, decide }).root

    press(root, 'Decline Dana Kim')

    expect(decide).toHaveBeenCalledExactlyOnceWith(request, 'declined')
  })
})

function machineStatus(machineName: string): RpcResponse {
  return {
    id: 'status',
    ok: true,
    result: { hostPlatform: 'linux', machineName, hostMachine: { kind: 'desktop', model: null } }
  }
}
function expectNamedWarningAndConsent(root: ReactTestInstance, name: string): void {
  expect(texts(root).some((text) => text.includes(name))).toBe(true)
  press(root, 'Review Dana Kim')
  root.findByProps({ confirmLabel: 'Give access' })
  expect(texts(root)).toContain(`They’ll act as you on ${name}.`)
  press(root, 'Cancel')
}

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

    press(root, 'Keep only me')
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
          online: true,
          hostName: 'Studio Mac',
          home: { folderPath: '/Users/me/.orca/bots/scout', onDeleted: () => {} },
          accessRequests: null,
          upNext: { lookNow: () => {}, busy: false }
        })
      )
    })
    openWhoCanAsk(tree!.root)
    press(tree!.root, 'Keep only me')
    await act(async () => press(tree!.root, 'Keep only me'))
    expect(showToast).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Sam, Bea'), 2400)
  })

  it('asks before starting new conversations in Ask for approval', async () => {
    const sent: { method: string; params: unknown }[] = []
    const ok: RpcResponse = { id: 'u', ok: true, result: { bot: routeBot.bot } }
    const root = renderTab(null, { bot: shared, client: client(ok, sent) }).root
    press(root, 'Switch')
    await act(async () => press(root, 'Switch'))
    expect(sent.filter((entry) => entry.method === 'bots.update').map((e) => e.params)).toEqual([
      { botId: 'bot-1', updates: { permissionMode: 'ask' } }
    ])
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
