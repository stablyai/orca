import { expect, it } from 'vitest'
import type { BotGroup, BotGroupMessage, BotGroupTurn } from '../../shared/bots/bot-group'
import Database from '../sqlite/sync-database'
import { BotGroupStore } from './bot-group-store'

it('keeps each bot’s newest timeline reply and its original address across a reopen', () => {
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
      store.listing(true)[0].replyPreviews?.find(({ botId }) => botId === 'Scout')
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
          at: 5,
          text: 'The build is green.',
          messageId: 'third',
          sequence: other.sequence,
          operationId: 'other',
          replyMessageId: 'answer-other'
        }
      ])
    }
    expect(store.listing(true)).toMatchObject([expected])
    expect(store.listing(true)[0].replyPreviews).toHaveLength(2)
    expect(store.listing()[0].replyPreviews).toBeUndefined()
    expect(new BotGroupStore(db).listing(true)).toMatchObject([expected])
  } finally {
    db.close()
  }
})
