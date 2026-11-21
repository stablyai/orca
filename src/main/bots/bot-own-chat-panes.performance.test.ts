// Every bot's own side chats are classed with one party read per bot, not two SQLite lookups per
// chat: a host with many chats spent hundreds of milliseconds of main-thread time per refresh (PR #46120).
import { afterEach, expect, it, vi } from 'vitest'
import { buildBotChatBase, readBotChatInputs } from './bot-chat-tree-base'
import { readBotOwnChatPanes } from './bot-own-chat-panes'
import { bot, closeOwnChatHost, homeRecord, ownChatHost } from './bot-own-chat-panes.test-fixture'
import { makeTestBot } from './bot.test-fixture'

afterEach(closeOwnChatHost)

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

it('asks nothing of the database for chats running on another host', async () => {
  const records = Array.from({ length: 20 }, (_, i) => {
    const record = homeRecord(`chat-remote-${i}`, `Remote ${i}`)
    return { ...record, location: { ...record.location, executionHostId: 'ssh:devbox' as const } }
  })
  const host = ownChatHost(records)
  const store = await host.sessionRecords()
  const prepare = vi.spyOn(host.db().db, 'prepare')
  const build = buildBotChatBase(
    { db: host.db(), backgroundRuns: host.backgroundRuns },
    store,
    readBotChatInputs(host, bot),
    store?.listRecords() ?? []
  )
  expect(build.chats.size).toBe(20)
  expect(prepare.mock.calls.filter(([sql]) => PARTY_SQL.test(sql))).toHaveLength(0)
})
