import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const bots: Record<string, unknown>[] = []
  // The asked bot's row status, as the host's list last drew it.
  const noStatus = (): string | null => null
  const status = noStatus()
  const links: unknown[] = []
  const copied: string[] = []
  const edits: unknown[] = []
  const chats: unknown[] = []
  return { bots, status, rpc: vi.fn(), links, copied, edits, chats }
})

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement(name, props, children)
  return {
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    Image: host('Image'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
// Every icon draws as its own name.
vi.mock(
  'lucide-react-native',
  () =>
    new Proxy(
      {},
      { get: (_icons, name) => (name === 'then' ? undefined : String(name)), has: () => true }
    )
)
vi.mock('../../../../bots/MobileBotAvatar', () => ({ MobileBotAvatar: 'Avatar' }))
vi.mock('../../../../bots/host-bot-store', () => ({
  useHostBotById: (id: string) => state.bots.find((bot) => bot.id === id) ?? null,
  useHostBotStatus: () => state.status,
  useHostBotsEntry: () => ({ bots: state.bots }),
  publishHostBot: vi.fn()
}))
vi.mock('../../../../bots/pending-bot-link', () => ({
  publishBotLink: (target: unknown) => state.links.push(target)
}))
vi.mock('../../../../platform/clipboard/clipboard', () => ({
  useClipboardWriter: () => ({
    writeText: async (text: string) => {
      state.copied.push(text)
    }
  })
}))
vi.mock('../../../../hooks/use-now', () => ({ useNow: () => 1_000_000 }))
vi.mock('../../../../worktree/execution-hosts/use-route-capability', () => ({
  useRouteCapability: () => true
}))

import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { MobileNativeChatBotIdentityContext } from '../../mobile-native-chat-bot-identity'
import { MobileBotCardHostContext, MobileBotCardSendContext } from './mobile-bot-card-host'
import {
  mobileNativeChatBotCard,
  mobileNativeChatOtherBotCard
} from './mobile-native-chat-bot-cards'

const client: RpcClient = {
  sendRequest: state.rpc,
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}
const atlas = {
  id: 'atlas',
  name: 'Atlas',
  avatar: null,
  agent: 'claude',
  folderWorkspaceId: 'atlas-home',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null
}
const finance = { ...atlas, id: 'finance', name: 'Finance', folderWorkspaceId: 'finance-home' }

/** The host's answer to each method, as the phone's RPC client returns it. */
function answer(results: Record<string, unknown>): void {
  state.rpc.mockImplementation(async (method: string) => ({
    id: '1',
    ok: true,
    result: results[method]
  }))
}

/** The params each call to `method` sent. */
function sent(method: string): unknown[] {
  return state.rpc.mock.calls.filter(([called]) => called === method).map(([, params]) => params)
}

function textOf(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('')
}

async function render(node: ReactNode, send = vi.fn(async () => true)) {
  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(
      createElement(
        MobileBotCardHostContext.Provider,
        {
          value: {
            client,
            hostKey: 'host\nlocal',
            pairedHostId: 'host',
            hostLabel: 'Maya’s MacBook Pro',
            editOffer: (offer: unknown) => state.edits.push(offer),
            openBotChat: (bot: { id: string }, chatId: string) =>
              state.chats.push({ botId: bot.id, chatId })
          }
        },
        createElement(
          MobileBotCardSendContext.Provider,
          { value: send },
          createElement(
            MobileNativeChatBotIdentityContext.Provider,
            { value: { botId: 'atlas', name: 'Atlas', avatar: { kind: 'text', text: 'A' } } },
            node
          )
        )
      )
    )
  })
  const root = renderer!.root
  return {
    text: () => textOf(root),
    press: async (label: string) => {
      const pill = root
        .findAll((n) => String(n.type) === 'Pressable' && n.props.accessibilityRole === 'button')
        .find((n) => textOf(n).includes(label))
      if (!pill) {
        throw new Error(`No ${label} in: ${textOf(root)}`)
      }
      await act(async () => {
        pill.props.onPress()
        // Let the press's host calls answer.
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    },
    buttons: () =>
      root
        .findAll((n) => String(n.type) === 'Pressable' && n.props.hitSlop === 8)
        .map((n) => textOf(n))
  }
}

const context = { cardId: 'card-1', timestamp: 0, fallback: 'Host line', fontScale: 1 }

afterEach(() => {
  state.bots = []
  state.status = null
  state.rpc.mockReset()
  state.links = []
  state.copied = []
  state.edits = []
  state.chats = []
})

describe('bot request card', () => {
  const card = {
    toBotId: 'finance',
    toBotName: 'Finance',
    purpose: 'question' as const,
    subject: 'GPU spend?'
  }

  it('shows the asked bot working, then its answer, and opens the bot', async () => {
    state.bots = [finance]
    state.status = 'working'
    answer({ 'bots.request.outcome': { outcome: null, answer: null } })
    const working = await render(
      mobileNativeChatBotCard({ botRequest: { ...card, messageId: 'm1' } }, context)
    )
    expect(working.text()).toContain('Asked')
    expect(working.text()).toContain('Finance · working…')
    expect(working.text()).toContain('GPU spend?')
    await working.press('Open its chat')
    expect(state.links).toEqual([{ kind: 'bot', botId: 'finance' }])

    answer({
      'bots.request.outcome': {
        outcome: 'answered',
        answer: '$4,212',
        mailIds: [],
        chatId: 'finance-q3'
      }
    })
    const answered = await render(
      mobileNativeChatBotCard({ botRequest: { ...card, messageId: 'm1' } }, context)
    )
    expect(answered.text()).toContain('Finance · ✓ answered')
    expect(answered.text()).toContain('$4,212')
    await answered.press('Open its chat')
    expect(state.chats).toEqual([{ botId: 'finance', chatId: 'finance-q3' }])
  })

  it('says why it was not sent, without opening anything', async () => {
    state.bots = [finance]
    const refused = await render(
      mobileNativeChatBotCard({ botRequest: { ...card, refusal: 'bot_paused' } }, context)
    )
    expect(refused.text()).toContain('Not sent to')
    expect(refused.text()).toContain('Finance is paused.')
    expect(refused.text()).not.toContain('Open its chat')
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('shows the host line for a bot this phone does not list', async () => {
    const unknown = await render(mobileNativeChatBotCard({ botRequest: card }, context))
    expect(unknown.text()).toBe('Host line')
  })
})

describe('new-bot offer card', () => {
  const offer = {
    botId: 'atlas',
    offerId: 'o1',
    offeredAt: 1,
    proposal: {
      name: 'Release',
      purpose: 'Tracks the release.',
      watches: 'Issues labelled 1.5',
      worktrees: [
        { id: 'w1', name: 'release-1.5' },
        { id: 'w2', name: 'docs' }
      ]
    }
  }

  it('offers Dismiss, Edit and Create bot, and creates from the offer', async () => {
    state.bots = [atlas]
    answer({ 'bots.create': { bot: { ...atlas, id: 'release', name: 'Release' } } })
    const card = await render(mobileNativeChatBotCard({ botCreateOffer: offer }, context))
    expect(card.text()).toContain('Release')
    expect(card.text()).toContain('Takes over 2 workspaces')
    expect(card.text()).toContain('Dismiss')
    expect(card.text()).toContain('Edit')
    expect(card.text()).not.toContain('Issues labelled 1.5')
    await card.press('Release')
    expect(card.text()).toContain('Issues labelled 1.5')
    await card.press('Create bot')
    expect(sent('bots.create')).toEqual([
      expect.objectContaining({ name: 'Release', fromOffer: { botId: 'atlas', offerId: 'o1' } })
    ])
  })

  it('claims a Dismiss on the host before telling the bot', async () => {
    state.bots = [atlas]
    answer({ 'bots.update': { bot: atlas } })
    const send = vi.fn(async () => true)
    const card = await render(mobileNativeChatBotCard({ botCreateOffer: offer }, context), send)
    await card.press('Dismiss')
    expect(sent('bots.update')).toEqual([
      {
        botId: 'atlas',
        updates: { offerAnswer: { cardId: 'card-1', dismissed: true, claim: true } }
      }
    ])
    expect(send).toHaveBeenCalledWith('Dismiss')
  })

  it('reads dismissed, name taken and created from the bots there are', async () => {
    state.bots = [{ ...atlas, offerAnswers: [{ cardId: 'card-1', dismissed: true }] }]
    const dismissed = await render(mobileNativeChatBotCard({ botCreateOffer: offer }, context))
    expect(dismissed.text()).not.toContain('Dismiss')
    expect(dismissed.text()).toContain('Create bot')

    state.bots = [atlas, { ...finance, id: 'other', name: 'release' }]
    const taken = await render(mobileNativeChatBotCard({ botCreateOffer: offer }, context))
    expect(taken.text()).toContain('You already have a bot named Release.')
    expect(taken.text()).toContain('Rename')
    expect(taken.text()).not.toContain('Create bot')

    state.bots = [
      { ...atlas, acceptedOffers: [{ offerId: 'o1', botId: 'release' }] },
      { ...finance, id: 'release', name: 'Release', folderWorkspaceId: 'release-home' }
    ]
    answer({ 'worktree.lineageList': { lineage: {}, workspaceLineage: {} } })
    const created = await render(mobileNativeChatBotCard({ botCreateOffer: offer }, context))
    expect(created.text()).toContain('Created · asked to take over 2 workspaces')
    await created.press('Open')
    expect(state.links).toEqual([{ kind: 'bot', botId: 'release' }])
  })

  it('edits in New bot, pinned to the proposer and answering this card', async () => {
    state.bots = [atlas]
    const card = await render(mobileNativeChatBotCard({ botCreateOffer: offer }, context))
    await card.press('Edit')
    expect(state.edits).toEqual([
      {
        proposal: offer.proposal,
        agent: 'claude',
        fromOffer: { botId: 'atlas', offerId: 'o1' },
        origin: 'Proposed by Atlas',
        templatePackages: true
      }
    ])
  })

  it('opens Edit without an agent when the proposer’s is unknown, and says why Create is off', async () => {
    state.bots = [{ ...atlas, agent: 'someday-agent' }]
    const card = await render(mobileNativeChatBotCard({ botCreateOffer: offer }, context))
    expect(card.text()).toContain('Atlas runs an agent this app doesn’t know. Edit to pick one.')
    await card.press('Edit')
    expect(state.edits).toEqual([expect.not.objectContaining({ agent: expect.anything() })])
  })
})

describe('memory updated row', () => {
  it('folds open to each change, with no link', async () => {
    const note = {
      botId: 'atlas',
      added: ['Digest at 8:30'],
      removed: ['Post in #general'],
      topics: ['notes/a.md'],
      otherChanges: 0
    }
    const row = await render(mobileNativeChatBotCard({ botMemoryUpdated: note }, context))
    expect(row.text()).toContain('Memory updated · 3 changes')
    expect(row.text()).not.toContain('Digest at 8:30')
    await row.press('Memory updated')
    expect(row.text()).toContain('Digest at 8:30')
    expect(row.text()).toContain('Post in #general')
    expect(row.text()).toContain('notes/a.md')
    expect(row.text()).not.toContain('Open memory')
  })
})

describe('tool added card', () => {
  const added = {
    botId: 'atlas',
    tool: { name: 'notion', detail: 'https://mcp.notion.com/mcp', remote: true },
    addedAt: 1
  }

  it('points a tool that needs a sign-in to the computer, and removes it', async () => {
    answer({
      'bots.tools.list': { own: [{ ...added.tool, signIn: { state: 'signed-out' } }] },
      'bots.tools.remove': {}
    })
    const card = await render(
      mobileNativeChatOtherBotCard({ kind: 'toolAdded', value: added }, context)
    )
    expect(card.text()).toContain('Notion')
    expect(card.text()).toContain('Sign in on your computer')
    expect(card.buttons()).toEqual(['Remove'])
    await card.press('Remove')
    expect(sent('bots.tools.remove')).toEqual([{ botId: 'atlas', name: 'notion' }])
  })

  it('reads Signed in, and Removed once the bot no longer has it', async () => {
    answer({ 'bots.tools.list': { own: [{ ...added.tool, signIn: { state: 'signed-in' } }] } })
    const signedIn = await render(
      mobileNativeChatOtherBotCard({ kind: 'toolAdded', value: added }, context)
    )
    expect(signedIn.text()).toContain('Signed in')
    answer({ 'bots.tools.list': { own: [] } })
    const removed = await render(
      mobileNativeChatOtherBotCard({ kind: 'toolAdded', value: added }, context)
    )
    expect(removed.text()).toContain('Removed')
    expect(removed.buttons()).toEqual([])
  })
})

describe('webhook card', () => {
  const hook = {
    hookId: 'wh_7Kx2pQ9mT4vB8nLc',
    botId: 'atlas',
    state: 'live',
    url: 'https://hooks.example/wh_7Kx2pQ9mT4vB8nLc',
    automationName: 'Deploy finished',
    adapter: null,
    lastCall: null
  }

  it('masks the URL in the hook bot’s own chat and copies the one with its key', async () => {
    answer({ 'webhooks.card': hook, 'webhooks.reveal': { url: `${hook.url}/k3y`, key: 'k3y' } })
    const card = await render(
      mobileNativeChatOtherBotCard({ kind: 'webhook', value: { hookId: hook.hookId } }, context)
    )
    expect(card.text()).toContain('Webhook · starts “Deploy finished”')
    expect(card.text()).toContain('No calls yet')
    expect(card.text()).toContain(`${hook.url}/••••••••`)
    expect(card.text()).not.toContain('Rotate')
    await card.press('Copy URL')
    expect(sent('webhooks.reveal')).toEqual([{ hookId: hook.hookId }])
    expect(state.copied).toEqual([`${hook.url}/k3y`])
  })

  it('says where the URL is in another bot’s chat', async () => {
    state.bots = [finance]
    answer({ 'webhooks.card': { ...hook, botId: 'finance' } })
    const card = await render(
      mobileNativeChatOtherBotCard({ kind: 'webhook', value: { hookId: hook.hookId } }, context)
    )
    expect(card.text()).toContain('Webhook “Deploy finished” is live.')
    expect(card.text()).not.toContain(hook.url)
  })
})
