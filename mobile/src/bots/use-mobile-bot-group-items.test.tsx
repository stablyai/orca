import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { PhoneBot } from './host-bots-operations'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))

const MEMBERS = 32
const THREAD_MEMBERS = 4
const host = vi.hoisted(
  (): {
    groupLists: number
    itemReads: string[]
    threadId: string | undefined
    group: BotGroup | null
  } => ({
    groupLists: 0,
    itemReads: [],
    threadId: undefined,
    group: null
  })
)

function bot(index: number): PhoneBot {
  return {
    id: `bot-${index}`,
    name: `Bot ${index}`,
    folderWorkspaceId: `home-${index}`,
    avatar: null,
    paused: false,
    agent: 'claude',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null
  }
}
const BOTS = Array.from({ length: MEMBERS }, (_, index) => bot(index))
const GROUP: BotGroup = {
  id: 'g',
  name: 'Crew',
  hostId: 'local',
  revision: 1,
  folder: 'group-crew',
  folderWorkspaceId: 'fw-g',
  createdAt: 1,
  replyMode: { kind: 'mentions' },
  members: BOTS.map((entry) => ({ botId: entry.id, sessionId: `room-${entry.id}` }))
}

vi.mock('./host-bots-read', () => ({
  readHostBots: async () => ({ kind: 'bots', bots: BOTS, needsYou: {} })
}))
vi.mock('./bot-group-operations', () => ({
  // A thread's room read lists only the thread's members.
  groupRead: {
    request: async (_client: RpcClient, { threadId }: { threadId?: string }) => ({
      group: threadId ? { ...GROUP, members: GROUP.members.slice(0, THREAD_MEMBERS) } : GROUP,
      messages: [],
      hasEarlier: false
    }),
    interpret: (reply: unknown) => reply
  },
  groupList: {
    request: async () => {
      host.groupLists += 1
      return { groups: [host.group ?? GROUP] }
    },
    interpret: (reply: unknown) => reply
  }
}))
vi.mock('./items/bot-item-operations', () => ({
  readBotItems: async (_client: RpcClient, botId: string) => {
    host.itemReads.push(botId)
    return { kind: 'read', value: { items: [], counts: {}, seenEventId: '' } }
  }
}))

const { useMobileBotGroupTranscript } = await import('./use-mobile-bot-group-transcript')
const { useMobileBotGroupItems } = await import('./use-mobile-bot-group-items')

let emit: (payload: unknown) => void = () => {}
const client: RpcClient = {
  sendRequest: async () => ({ id: 'a', ok: true, result: {} }),
  subscribe: (_method, _params, listener) => {
    emit = listener
    return () => {}
  },
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

// Stable, as the room's are: the scopes (and so every read's chats) follow `t`, the refresh `setError`.
const t = (_key: string, fallback: string): string => fallback
const setError = (): void => {}

// The room and its Items drawer, wired as MobileBotGroupRoom and MobileBotGroupItems wire them.
function Room(): ReactNode {
  const room = useMobileBotGroupTranscript(client, GROUP.id, host.threadId, 'local', true, setError)
  const read = useMobileBotGroupItems({
    visible: true,
    client,
    groupId: GROUP.id,
    bots: room.bots,
    needsYou: room.needsYou,
    reads: room.itemReads,
    memberIds: room.itemMemberIds,
    now: 0,
    t
  })
  return read.readers
}

let tree: ReactTestRenderer | null = null

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function notice(payload: Record<string, unknown>): Promise<void> {
  host.groupLists = 0
  host.itemReads = []
  act(() => emit({ type: 'botsChanged', ...payload }))
  await settle()
}

async function openRoom(threadId: string | undefined): Promise<void> {
  host.groupLists = 0
  host.itemReads = []
  host.threadId = threadId
  host.group = null
  act(() => {
    tree = create(createElement(Room))
  })
  await settle()
  expect(host.itemReads).toHaveLength(MEMBERS)
}

describe('useMobileBotGroupItems', () => {
  beforeEach(() => openRoom(undefined))
  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  it("re-reads only the member an items notice names, and not the group's rooms", async () => {
    await notice({ botIds: ['bot-3'], kinds: ['items'] })
    expect(host.itemReads).toEqual(['bot-3'])
    expect(host.groupLists).toBe(0)
  })

  it("re-reads only the group's rooms on a groups notice", async () => {
    await notice({ kinds: ['groups'] })
    expect(host.itemReads).toEqual([])
    expect(host.groupLists).toBe(1)
  })

  it('re-reads every member once when a groups notice adds a thread', async () => {
    host.group = {
      ...GROUP,
      threads: [{ id: 'thread-2', createdAt: 2, members: GROUP.members.slice(0, 2) }]
    }
    await notice({ kinds: ['groups'] })
    expect(host.itemReads).toHaveLength(MEMBERS)
    expect(host.groupLists).toBe(1)
  })

  it('re-reads no member for a bot outside the group', async () => {
    await notice({ botIds: ['bot-outside'], kinds: ['items'] })
    expect(host.itemReads).toEqual([])
    expect(host.groupLists).toBe(0)
  })

  it('re-reads every member on a notice that names no bot', async () => {
    await notice({ kinds: ['workers'] })
    expect(host.itemReads).toHaveLength(MEMBERS)
    await notice({})
    expect(host.itemReads).toHaveLength(MEMBERS)
    expect(host.groupLists).toBe(1)
  })
})

describe('useMobileBotGroupItems in a thread room', () => {
  beforeEach(() => openRoom('thread-1'))
  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  it("re-reads a member the drawer shows that the thread's roster leaves out", async () => {
    await notice({ botIds: [`bot-${MEMBERS - 1}`], kinds: ['items'] })
    expect(host.itemReads).toEqual([`bot-${MEMBERS - 1}`])
    expect(host.groupLists).toBe(0)
  })
})
