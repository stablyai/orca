import { expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { botGroupReplyBodies, restoreBotGroupReplies } from '../../shared/bots/bot-group-transcript'
import type { BotGroup, BotGroupTurn } from '../../shared/bots/bot-group'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readBotGroup } from './bot-group-delivery'
import type { BotGroupRuntime } from './bot-group-runtime'
import { BotGroupStore } from './bot-group-store'
import { readBotGroupTurnSource } from './bot-group-turn-source'

// #47176: a matching room notice only carries preview bodies the reader does not hold.
it('recovers the page with zero repeated reply bodies and one changed body at both sizes', () => {
  for (const count of [100, 1_000]) {
    const db = new OrchestrationDb(':memory:')
    try {
      const store = new BotGroupStore(db.db)
      const group: BotGroup = {
        id: 'group',
        name: 'Crew',
        hostId: 'local',
        revision: 1,
        folder: 'crew',
        folderWorkspaceId: 'home',
        members: [],
        createdAt: 1,
        replyMode: { kind: 'mentions' }
      }
      store.put(group)
      for (let post = 0; post < 40; post++) {
        const turns: BotGroupTurn[] = Array.from(
          { length: Math.floor(count / 40) + (post < count % 40 ? 1 : 0) },
          (_, member) => ({
            operationId: `turn-${post}-${member}`,
            botId: `bot-${member}`,
            botName: `Bot ${member}`,
            avatar: null,
            agent: 'codex',
            sessionId: `room-bot-${member}`,
            end: 'finished',
            reply: `${'Earlier progress.\n'.repeat(155)}Done ${post}/${member}.`
          })
        )
        store.append({
          id: `post-${post}`,
          groupId: group.id,
          author: { kind: 'owner' },
          text: 'Check the status',
          createdAt: post + 2,
          turns
        })
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- Only store-backed posts are seeded.
      const runtime = { store, mailTurnChecks: new Map() } as unknown as BotGroupRuntime
      const load = (keys?: string[]) => readBotGroup(runtime, group.id, undefined, undefined, keys)
      const initial = load([])
      const held = botGroupReplyBodies(initial)
      expect(held.size).toBe(count)
      const unchanged = load([...held.keys()])
      expect(botGroupReplyBodies(unchanged).size).toBe(0)
      expect(restoreBotGroupReplies(unchanged, held)).toEqual(initial)

      const changed = store.message('post-39')!
      store.update({
        ...changed,
        turns: [{ ...changed.turns[0], reply: 'Updated answer.' }, ...changed.turns.slice(1)]
      })
      const delta = load([...held.keys()])
      expect([...botGroupReplyBodies(delta).values()]).toEqual(['Updated answer.'])
      expect(restoreBotGroupReplies(delta, held)).toEqual(load([]))
      expect(load().messages.at(-1)?.turns[0].reply).toBeUndefined()
    } finally {
      db.close()
    }
  }
})

it('reads the frozen source once across consecutive detail pages at both sizes', () => {
  for (const count of [1_000, 10_000]) {
    const db = new OrchestrationDb(':memory:')
    try {
      const store = new BotGroupStore(db.db)
      const operationId = 'frozen'
      const frozenItems = Array.from({ length: count }, (_, index): AgentJournalRenderItem => ({
        itemId: `row-${index}`,
        revision: 1,
        sequence: index + 1,
        observedAt: index + 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'row' }] }
      }))
      const stored = store.append({
        id: 'post',
        groupId: 'room',
        author: { kind: 'owner' },
        text: 'Check the status',
        createdAt: 2,
        turns: [
          {
            operationId,
            botId: 'retired',
            botName: 'Retired',
            avatar: null,
            agent: 'codex',
            sessionId: 'retired-session',
            revoked: true,
            frozenItems
          }
        ]
      })
      const source = vi.spyOn(db.db, 'prepare')
      const read = (before?: number) =>
        readBotGroupTurnSource(db.db, {
          ...store.detailSource(operationId)!,
          groupId: 'room',
          operationId,
          before
        })
      const newest = read()
      expect(newest?.kind).toBe('frozen')
      if (newest?.kind !== 'frozen') {
        throw new Error('Missing frozen page')
      }
      expect(newest.page.items).toHaveLength(128)
      expect(newest.page.items.at(-1)?.sequence).toBe(count)
      const older = read(newest.page.before?.journal?.[0])
      expect(older?.kind === 'frozen' && older.page.items.at(-1)?.sequence).toBe(count - 128)
      expect(
        source.mock.calls.filter(([sql]) =>
          sql.includes("SELECT json_remove(turn.value,'$.frozenItems')")
        )
      ).toHaveLength(1)

      store.update({ ...stored, turns: [{ ...stored.turns[0], frozenItems: [] }] }, true)
      expect(read()).toEqual({ kind: 'frozen', page: { items: [] } })

      for (let index = 0; index < 9; index++) {
        const nextOperationId = `next-frozen-${index}`
        store.append({
          id: `next-post-${index}`,
          groupId: 'room',
          author: { kind: 'owner' },
          text: 'Check the next status',
          createdAt: index + 3,
          turns: [
            {
              operationId: nextOperationId,
              botId: `next-retired-${index}`,
              botName: 'Next retired',
              avatar: null,
              agent: 'codex',
              sessionId: `next-retired-session-${index}`,
              revoked: true,
              frozenItems: []
            }
          ]
        })
        expect(
          readBotGroupTurnSource(db.db, {
            ...store.detailSource(nextOperationId)!,
            groupId: 'room',
            operationId: nextOperationId
          })?.kind
        ).toBe('frozen')
      }
      expect(
        db.db.prepare('SELECT COUNT(*) AS count FROM bot_group_archive_turn').get().count
      ).toBe(8)
      const interleaved = 'next-frozen-1'
      expect(
        readBotGroupTurnSource(db.db, {
          ...store.detailSource(interleaved)!,
          groupId: 'room',
          operationId: interleaved
        })?.kind
      ).toBe('frozen')
      expect(
        source.mock.calls.filter(([sql]) =>
          sql.includes("SELECT json_remove(turn.value,'$.frozenItems')")
        )
      ).toHaveLength(11)
    } finally {
      db.close()
    }
  }
})
