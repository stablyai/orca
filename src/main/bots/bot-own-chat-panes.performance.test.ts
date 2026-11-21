// Every bot's own side chats are classed with one party read per bot, not two SQLite lookups per
// chat: a host with many chats spent hundreds of milliseconds of main-thread time per refresh (PR #46120).
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { buildBotChatBase, readBotChatInputs } from './bot-chat-tree-base'
import { readBotOwnChatPanes } from './bot-own-chat-panes'
import { bot, closeOwnChatHost, homeRecord, ownChatHost } from './bot-own-chat-panes.test-fixture'
import { makeTestBot } from './bot.test-fixture'

afterEach(() => {
  setStructuredAgentSessionHost(null)
  closeOwnChatHost()
})

// The two rows naming a session's party: its worker terminal and whether a Dispatch recorded it as a worker.
const PARTY_SQL =
  /(worker_terminal_resources|dispatch_contexts d?)\s+WHERE (d\.)?(process_incarnation|assignee_orca_session_id) =/

it('reads the parties of every bot’s side chats in one query per bot, however many chats', async () => {
  const bots = Array.from({ length: 5 }, (_, i) =>
    makeTestBot({ id: `bot-${i}`, folderWorkspaceId: `home-${i}`, chatSessionId: `home-chat-${i}` })
  )
  const records = bots.flatMap((each, i) =>
    Array.from({ length: 20 }, (_, j) =>
      homeRecord(`chat-${i}-${j}`, `Side ${i}-${j}`, each.folderWorkspaceId)
    )
  )
  const host = ownChatHost(records, bots)
  const prepare = vi.spyOn(host.db().db, 'prepare')
  const chats = await readBotOwnChatPanes(host)
  expect(Object.values(chats).flat()).toHaveLength(100)
  // One for each bot's base build and one for its ownership pass.
  expect(prepare.mock.calls.filter(([sql]) => PARTY_SQL.test(sql))).toHaveLength(10)
})

it('builds chats running on another host with one lineage walk each and no database read', async () => {
  for (const count of [20, 200]) {
    const records = Array.from({ length: count }, (_, i) => {
      const record = homeRecord(`chat-remote-${i}`, `Remote ${i}`)
      return { ...record, location: { ...record.location, executionHostId: 'ssh:devbox' as const } }
    })
    const host = ownChatHost(records)
    const store = await host.sessionRecords()
    if (!store) {
      throw new Error('fixture store missing')
    }
    const getRecord = vi.spyOn(store, 'getRecord')
    const prepare = vi.spyOn(host.db().db, 'prepare')
    const build = buildBotChatBase(
      { db: host.db(), backgroundRuns: host.backgroundRuns },
      store,
      readBotChatInputs(host, bot),
      store.listRecords()
    )
    expect(build.chats.size).toBe(count)
    expect(prepare.mock.calls.filter(([sql]) => PARTY_SQL.test(sql))).toHaveLength(0)
    // Per chat: its lineage walked once, and its root read once for the closed check.
    expect(getRecord).toHaveBeenCalledTimes(count * 2)
    closeOwnChatHost()
  }
})

it('reads a chat a /clear continued into another session from the batch', async () => {
  const first = homeRecord('chat-alpha', 'Cleared chat')
  const cleared = {
    ...first,
    conversationCommand: {
      command: 'clear' as const,
      runtimeFence: 8,
      operationId: 'op-clear-chat-alpha',
      callerKey: 'renderer',
      phase: 'committed' as const,
      state: 'completed' as const,
      replacementSessionId: 'chat-beta'
    }
  }
  const records = [cleared, homeRecord('chat-beta', 'Cleared chat')]
  const host = ownChatHost(records)
  const store = await host.sessionRecords()
  const views = new Map(records.map((r) => [r.sessionId, agentSessionConversationView(r)]))
  // The runtime's record store, which the party lookup canonicalizes through; the same records the
  // build reads, as in the app.
  const runtimeHost = {
    deps: {
      store: {
        getConversation: (id: string) => views.get(id) ?? null,
        listConversations: () => [...views.values()],
        getVisibleSessionTabIndex: () => ({ present: false, sessionIds: [] })
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lineage reader reads only deps.store; any other call fails the test.
  setStructuredAgentSessionHost(runtimeHost as unknown as StructuredAgentSessionHost)
  const prepare = vi.spyOn(host.db().db, 'prepare')
  const build = buildBotChatBase(
    { db: host.db(), backgroundRuns: host.backgroundRuns },
    store,
    readBotChatInputs(host, bot),
    store?.listRecords() ?? []
  )
  expect(
    [...build.chats.values()].map((chat) => [chat.chatId, chat.liveSessionId, chat.closed])
  ).toEqual([['chat-alpha', 'chat-beta', false]])
  // The batch alone: a lookup that missed it would add two point reads.
  expect(prepare.mock.calls.filter(([sql]) => PARTY_SQL.test(sql))).toHaveLength(1)
})

it('reads no record history for a bot without side chats', async () => {
  const bots = Array.from({ length: 5 }, (_, i) =>
    makeTestBot({ id: `bot-${i}`, folderWorkspaceId: `home-${i}`, chatSessionId: `home-chat-${i}` })
  )
  const host = ownChatHost(
    bots.map((each, i) => homeRecord(`home-chat-${i}`, `Home ${i}`, each.folderWorkspaceId)),
    bots
  )
  const store = await host.sessionRecords()
  if (!store) {
    throw new Error('fixture store missing')
  }
  const listRecords = vi.spyOn(store, 'listRecords')
  expect(await readBotOwnChatPanes(host)).toEqual({})
  // Each bot's base build only: two per bot, none for an ownership pass with nothing to class.
  expect(listRecords).toHaveBeenCalledTimes(10)
})
