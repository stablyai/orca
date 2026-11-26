import { afterEach, expect, it } from 'vitest'
import {
  BOT_GROUP_PAGE_REPLY_MAX,
  botGroupPageReply,
  withBotGroupTurnAnswer
} from '../../shared/bots/bot-group-reply-preview'
import type { BotGroupTurn } from '../../shared/bots/bot-group'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../shared/remote-runtime/remote-runtime-memory-limits'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readBotGroup } from './bot-group-delivery'
import type { BotGroupRuntime } from './bot-group-runtime'
import { BotGroupStore } from './bot-group-store'
import { settledGroupRoomReply } from './bot-group-turn-end'

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

  const [message] = readBotGroup(groups, 'group-1', undefined, undefined, []).messages
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

  for (let index = 0; index < 40; index++) {
    store.append({
      id: `newer-${index}`,
      groupId: 'group-1',
      author: { kind: 'owner' },
      text: 'A newer post',
      createdAt: index + 3,
      turns: []
    })
  }
  const refreshed = readBotGroup(groups, 'group-1', undefined, undefined, [], ['message-1'])
  expect(refreshed.messages.some(({ id }) => id === 'message-1')).toBe(false)
  expect(refreshed.updatedPosts?.[0].turns[0].reply).toBe(finished.reply)
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
  expect(botGroupPageReply(`${'a'.repeat(5_000)}\n`)).toBe(`…\n\n${'a'.repeat(3_975)}\n`)
  // A longer fence holds shorter ones; the block stays open until its own fence closes it.
  const nested = botGroupPageReply(`\`\`\`\`md\n\`\`\`\n${'inner\n'.repeat(1_000)}Done.`)
  expect(nested.startsWith('…\n\n````text\ninner\n')).toBe(true)
  expect(botGroupPageReply('Short.')).toBe('Short.')
})

it('keeps a closing fence and the following prose when the opening is outside the saved tail', () => {
  const full = `\x60\x60\x60ts\n${'code line\n'.repeat(2_000)}\x60\x60\x60\n\nDone with **bold** prose.`
  expect(botGroupPageReply(full)).toMatch(
    /^…\n\n```text\ncode line[\s\S]+\n```\n\nDone with \*\*bold\*\* prose\.$/
  )
})

it('keeps the recent page when named older updates fill the transport budget', () => {
  const orchestration = new OrchestrationDb(':memory:')
  databases.push(orchestration)
  const store = new BotGroupStore(orchestration.db)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture needs only the store.
  const groups = { store, mailTurnChecks: new Map() } as unknown as BotGroupRuntime
  const groupId = 'group-1'
  store.put({
    id: groupId,
    name: 'Crew',
    hostId: 'local',
    revision: 1,
    folder: 'crew',
    folderWorkspaceId: 'home-1',
    createdAt: 1,
    members: [],
    replyMode: { kind: 'mentions' }
  })
  const olderIds = Array.from({ length: 40 }, (_, index) => `older-${index}`)
  const recent = Array.from({ length: 40 }, (_, index) => `recent-${index}`)
  for (const [index, id] of [...olderIds, ...recent].entries()) {
    store.append({
      id,
      groupId,
      text: 'Check the status',
      createdAt: index + 2,
      author: { kind: 'owner' },
      turns:
        index < olderIds.length
          ? Array.from({ length: 32 }, (_, member) =>
              turn(`${id}-${member}`, {
                end: 'finished',
                reply: `${'x'.repeat(3900)} ${id}-${member}`
              })
            )
          : []
    })
  }
  const page = readBotGroup(groups, groupId, undefined, undefined, [], olderIds)
  expect(page.messages.map(({ id }) => id)).toEqual(recent)
  expect(page.updatedPosts?.length).toBeGreaterThan(0)
  expect(page.deferredPostIds?.length).toBeGreaterThan(0)
  expect(
    new Set([...(page.updatedPosts ?? []).map(({ id }) => id), ...(page.deferredPostIds ?? [])])
  ).toEqual(new Set(olderIds))
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(
    REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
  )
})

it('keeps consecutive root answers and folds earlier work out of the saved reply', () => {
  const text = (sequence: number, content: string, agentId?: string): AgentJournalRenderItem => ({
    itemId: `row-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    agentId,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: content }] }
  })
  expect(
    settledGroupRoomReply([
      text(1, 'I will check the configuration.'),
      {
        ...text(2, ''),
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'tool-call', name: 'Read', input: { path: 'config' } }]
        }
      },
      text(3, 'Apply this configuration.'),
      text(4, 'Only the child agent said this.', 'child'),
      text(5, 'Restart afterward.')
    ])
  ).toBe('Apply this configuration.\n\nRestart afterward.')
})
