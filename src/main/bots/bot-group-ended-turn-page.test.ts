import { afterEach, expect, it } from 'vitest'
import {
  BOT_GROUP_PAGE_REPLY_MAX,
  botGroupPageReply,
  botGroupReplyTail,
  type BotGroupTurn,
  withBotGroupTurnAnswer
} from '../../shared/bots/bot-group-schema'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readBotGroup } from './bot-group-delivery'
import type { BotGroupRuntime } from './bot-group-runtime'
import { BotGroupStore } from './bot-group-store'

// A long member turn pushes its own send off the member chat's loaded page; once it ended the room
// draws it from what its post saved, never "Starting…" (#46084).

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

const turn = (operationId: string, saved: Partial<BotGroupTurn> = {}): BotGroupTurn => ({
  operationId,
  botId: 'bot-1',
  botName: 'Ada',
  avatar: 'A',
  agent: 'claude',
  sessionId: 'bot-group-member-1',
  ...saved
})

it("sends each ended turn's saved reply and end, cut per turn, and never stores the cut", () => {
  const orchestration = new OrchestrationDb(':memory:')
  databases.push(orchestration)
  const store = new BotGroupStore(orchestration.db)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a page read with no remote asks or mail turns touches only the store.
  const groups = { store, mailTurnChecks: new Map() } as unknown as BotGroupRuntime
  store.put({
    id: 'group-1',
    name: 'Crew',
    hostId: 'local',
    revision: 1,
    folder: 'group-crew',
    folderWorkspaceId: 'home-1',
    createdAt: 1,
    members: [{ botId: 'bot-1', sessionId: 'bot-group-member-1' }],
    replyMode: { kind: 'mentions' }
  })
  const long = `${'intro line\n'.repeat(1_000)}Done.`
  store.append({
    id: 'message-1',
    groupId: 'group-1',
    author: { kind: 'owner' },
    text: '@Ada audit the repo',
    createdAt: 2,
    turns: [
      turn('finished', { reply: long, end: 'finished', workedMs: 2_700_000 }),
      turn('stopped', { reply: null, end: 'stopped', workedMs: 4_000 }),
      turn('running')
    ]
  })

  const [message] = readBotGroup(groups, 'group-1').messages
  const [finished, stopped, running] = message.turns
  expect(finished.reply).toBe(botGroupPageReply(long))
  expect(finished.reply!.length).toBeLessThan(BOT_GROUP_PAGE_REPLY_MAX + 10)
  expect([finished.end, finished.workedMs]).toEqual(['finished', 2_700_000])
  expect([stopped.reply, stopped.end]).toEqual([null, 'stopped'])
  expect([running.reply, running.end]).toEqual([undefined, undefined])
  // None of its rows loaded: the saved reply is the turn's answer; a running turn has none.
  expect(withBotGroupTurnAnswer([], finished).at(-1)?.blocks).toEqual([
    { type: 'text', text: finished.reply }
  ])
  expect(withBotGroupTurnAnswer([], running)).toEqual([])
  expect(store.message('message-1')!.turns[0].reply).toBe(long)
})

it('cuts a long reply on a whole line and reopens a code block the cut began inside', () => {
  const tail = 'const b = 2\n```\n\nDone, with **bold** prose.'
  const cut = botGroupPageReply(`${'```ts\n'}${'const a = 1\n'.repeat(1_000)}${tail}`)
  expect(cut.startsWith('…\n\n```text\nconst a = 1\n')).toBe(true)
  expect(cut.endsWith(tail)).toBe(true)
  // Whole code blocks after the cut stay as they are.
  const whole = `${'x'.repeat(BOT_GROUP_PAGE_REPLY_MAX)}\nIntro\n~~~sh\nls\n~~~\nDone.`
  expect(botGroupPageReply(whole)).toBe('…\n\nIntro\n~~~sh\nls\n~~~\nDone.')
  // A last block the reply never closed opened after the cut: the prose before it stays prose.
  const unclosed = botGroupPageReply(`${'prose line\n'.repeat(500)}Run this:\n\`\`\`sh\nls -la`)
  expect(unclosed.startsWith('…\n\nprose line\n')).toBe(true)
  // One line longer than the cap is cut mid-line rather than to nothing.
  expect(botGroupPageReply(`${'a'.repeat(5_000)}\n`)).toBe(`…\n\n${'a'.repeat(3_999)}\n`)
  // A longer fence holds shorter ones; the block stays open until its own fence closes it.
  const nested = botGroupPageReply(`\`\`\`\`md\n\`\`\`\n${'inner\n'.repeat(1_000)}Done.`)
  expect(nested.startsWith('…\n\n````text\ninner\n')).toBe(true)
  // A reply saved as its tail reopens its block at save, so the page's cut starts balanced.
  const saved = botGroupReplyTail(
    `\`\`\`ts\n${'const a = 1\n'.repeat(2_000)}\`\`\`\n${'prose\n'.repeat(1_000)}`,
    16_000
  )
  expect(botGroupPageReply(saved).startsWith('…\n\nprose\n')).toBe(true)
  expect(botGroupPageReply('Short.')).toBe('Short.')
})
