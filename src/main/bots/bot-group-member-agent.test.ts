import { describe, expect, it } from 'vitest'
import type { BotGroup } from '../../shared/bots/bot-group'
import SyncDatabase from '../sqlite/sync-database'
import type { BotGroupRuntime } from './bot-group-runtime'
import { roomsNeedingAgent, withSwappedBotGroupMember } from './bot-group-member-agent'
import { BotGroupStore } from './bot-group-store'

const GROUP: BotGroup = {
  id: 'room-1',
  name: 'Release',
  hostId: 'local',
  revision: 3,
  folder: '/work/release',
  folderWorkspaceId: 'folder:release',
  createdAt: 0,
  members: [
    { botId: 'bot-0', sessionId: 'bot-group-member-old' },
    { botId: 'bot-1', sessionId: 'bot-group-member-peer' }
  ],
  threads: [
    {
      id: 'thread-1',
      createdAt: 0,
      members: [
        { botId: 'bot-0', sessionId: 'bot-group-member-old-thread' },
        { botId: 'bot-1', sessionId: 'bot-group-member-peer-thread' }
      ]
    }
  ],
  replyMode: { kind: 'all' }
}

const rooms = () => {
  const store = new BotGroupStore(new SyncDatabase(':memory:'))
  store.put(GROUP)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: room selection reads only the group store.
  return { store } as unknown as BotGroupRuntime
}

describe("moving a bot's agent through its rooms", () => {
  it("replaces that bot's member in the original room and leaves the others alone", () => {
    const next = withSwappedBotGroupMember(GROUP, undefined, 'bot-0', {
      botId: 'bot-0',
      sessionId: 'bot-group-member-new'
    })
    expect(next.revision).toBe(4)
    expect(next.members).toEqual([
      { botId: 'bot-0', sessionId: 'bot-group-member-new' },
      { botId: 'bot-1', sessionId: 'bot-group-member-peer' }
    ])
    // The room still opens the chat that left it.
    expect(next.formerSessionIds).toEqual(['bot-group-member-old'])
    // Another room of the group keeps the chat it already has.
    expect(next.threads?.[0].members[0].sessionId).toBe('bot-group-member-old-thread')
    expect(next.threads?.[0].formerSessionIds).toBeUndefined()
  })

  it("replaces it in a thread, leaving the original room's member", () => {
    const next = withSwappedBotGroupMember(GROUP, 'thread-1', 'bot-0', {
      botId: 'bot-0',
      sessionId: 'bot-group-member-new-thread'
    })
    expect(next.revision).toBe(4)
    expect(next.members[0].sessionId).toBe('bot-group-member-old')
    expect(next.threads?.[0].members[0].sessionId).toBe('bot-group-member-new-thread')
    expect(next.threads?.[0].formerSessionIds).toEqual(['bot-group-member-old-thread'])
    expect(next.members).toHaveLength(2)
  })

  it('changes nothing when the room already has that session for the bot', () => {
    const same = withSwappedBotGroupMember(GROUP, undefined, 'bot-0', {
      botId: 'bot-0',
      sessionId: 'bot-group-member-old'
    })
    expect(same.members).toEqual(GROUP.members)
    expect(same.formerSessionIds).toBeUndefined()
  })

  it('lists each room the bot is in, and none it is not', () => {
    expect(roomsNeedingAgent(rooms(), 'bot-0')).toEqual([
      { groupId: 'room-1', threadId: undefined },
      { groupId: 'room-1', threadId: 'thread-1' }
    ])
    expect(roomsNeedingAgent(rooms(), 'bot-absent')).toEqual([])
  })
})
