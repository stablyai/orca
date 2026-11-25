import { expect, it } from 'vitest'
import type { BotGroup, BotGroupMessage, BotGroupTurn } from '../../shared/bots/bot-group'
import Database from '../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { recoverBotGroupReplies } from './bot-group-completed-replies'
import { BotGroupStore } from './bot-group-store'

it('keeps each bot’s newest timeline reply and its original address across a reopen', async () => {
  const db = new Database(':memory:')
  try {
    const store = new BotGroupStore(db)
    const group: BotGroup = {
      id: 'studio',
      name: 'Studio',
      hostId: 'local',
      revision: 1,
      folder: 'studio',
      folderWorkspaceId: 'studio-home',
      createdAt: 1,
      members: [],
      replyMode: { kind: 'mentions' }
    }
    store.put(group)
    const turn = (
      botId: string,
      operationId: string,
      reply: string,
      replyAt?: number
    ): BotGroupTurn => ({
      botId,
      botName: botId,
      sessionId: `bot-group-member-${botId}`,
      agent: 'claude',
      avatar: null,
      operationId,
      reply,
      replyAt,
      replyMessageId: `answer-${operationId}`
    })
    const post = (
      id: string,
      createdAt: number,
      turns: BotGroupTurn[],
      threadId?: string
    ): BotGroupMessage =>
      store.append({
        id,
        groupId: group.id,
        createdAt,
        turns,
        threadId,
        author: { kind: 'owner' },
        text: 'Status?'
      })

    const pending = { ...turn('Scout', 'slow', ''), reply: undefined, replyMessageId: undefined }
    const slow = post('first', 2, [pending])
    post('second', 3, [turn('Scout', 'fast', 'Still reviewing.', 4)])
    const other = post('third', 5, [turn('Atlas', 'other', 'The build is green.')])
    post('thread', 6, [turn('Scout', 'thread-reply', 'This is a thread answer.', 10)], 'thread')
    post('latest-owner', 11, [])
    expect(
      (await store.listing(true))[0].replyPreviews?.find(({ botId }) => botId === 'Scout')
    ).toMatchObject({
      operationId: 'fast'
    })
    store.update({ ...slow, turns: [turn('Scout', 'slow', 'The review\nis complete.', 8)] })

    const expected = {
      replyPreviews: expect.arrayContaining([
        {
          botId: 'Scout',
          at: 8,
          text: 'The review is complete.',
          messageId: 'first',
          sequence: slow.sequence,
          operationId: 'slow',
          replyMessageId: 'answer-slow'
        },
        {
          botId: 'Atlas',
          at: null,
          text: 'The build is green.',
          messageId: 'third',
          sequence: other.sequence,
          operationId: 'other',
          replyMessageId: 'answer-other'
        }
      ])
    }
    expect(await store.listing(true)).toMatchObject([expected])
    expect((await store.listing(true))[0].replyPreviews).toHaveLength(2)
    expect((await store.listing())[0].replyPreviews).toBeUndefined()
    expect(await new BotGroupStore(db).listing(true)).toMatchObject([expected])
  } finally {
    db.close()
  }
})

it('chooses a legacy reply by journal completion time even when the parent post was earlier', async () => {
  const db = new Database(':memory:')
  try {
    const store = new BotGroupStore(db)
    store.put({
      id: 'studio',
      name: 'Studio',
      hostId: 'local',
      folder: 'studio',
      folderWorkspaceId: 'home',
      revision: 1,
      createdAt: 1,
      members: [],
      replyMode: { kind: 'mentions' }
    })
    const turn: BotGroupTurn = {
      botId: 'scout',
      botName: 'Scout',
      sessionId: 'legacy-scout',
      operationId: 'slow',
      agent: 'claude',
      avatar: null,
      reply: 'The review is complete.'
    }
    const common = { groupId: 'studio', author: { kind: 'owner' as const }, text: 'Status?' }
    const post = store.append({ ...common, id: 'first', createdAt: 10, turns: [turn] })
    store.append({
      ...common,
      id: 'second',
      createdAt: 20,
      turns: [
        {
          ...turn,
          operationId: 'fast',
          reply: 'The preliminary result is ready.',
          replyAt: 30
        }
      ]
    })
    const body = {
      kind: 'turn',
      turnId: 'legacy-turn',
      state: 'completed',
      completedAt: 40
    } as const
    const origin = {
      revision: 1,
      observedAt: 42,
      turnScope: { kind: 'turn', turnItemId: 'legacy-turn' }
    } as const
    const items: AgentJournalRenderItem[] = [
      { ...origin, itemId: 'legacy-turn', sequence: 1, body },
      {
        ...origin,
        itemId: 'legacy-reply',
        sequence: 2,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'The review is complete.' }]
        }
      }
    ]
    const listed = await store.listing(true, (messages) =>
      recoverBotGroupReplies(messages, { turnItems: async () => new Map([['slow', items]]) })
    )
    expect(listed[0].replyPreviews).toEqual([
      {
        at: 40,
        botId: 'scout',
        text: 'The review is complete.',
        messageId: post.id,
        sequence: post.sequence,
        operationId: 'slow',
        replyMessageId: 'legacy-reply'
      }
    ])
  } finally {
    db.close()
  }
})
