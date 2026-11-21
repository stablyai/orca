// Every bot's own side chats are classed with one party read per bot, not two SQLite lookups per
// chat: a host with many chats spent hundreds of milliseconds of main-thread time per refresh (PR #TBD).
import { afterEach, expect, it, vi } from 'vitest'
import { readBotOwnChatPanes } from './bot-own-chat-panes'
import { closeOwnChatHost, homeRecord, ownChatHost } from './bot-own-chat-panes.test-fixture'
import { makeTestBot } from './bot.test-fixture'

afterEach(closeOwnChatHost)

// The two rows naming a session's party: its worker terminal and whether a Dispatch recorded it as a worker.
const PARTY_SQL =
  /FROM (worker_terminal_resources\s+WHERE process_incarnation|dispatch_contexts\s+WHERE assignee_orca_session_id)/

it('reads the parties of every bot’s side chats in two queries per bot, however many chats', async () => {
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
  // Two for each bot's base build and two for its ownership pass.
  expect(prepare.mock.calls.filter(([sql]) => PARTY_SQL.test(sql))).toHaveLength(20)
})
