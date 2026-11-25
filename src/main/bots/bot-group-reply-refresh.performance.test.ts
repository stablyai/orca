import { expect, it } from 'vitest'
import { botGroupReplyBodies, restoreBotGroupReplies } from '../../shared/bots/bot-group-transcript'
import type { BotGroup, BotGroupTurn } from '../../shared/bots/bot-group'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readBotGroup } from './bot-group-delivery'
import type { BotGroupRuntime } from './bot-group-runtime'
import { BotGroupStore } from './bot-group-store'

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
