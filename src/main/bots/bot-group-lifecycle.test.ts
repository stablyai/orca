import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { fixture, groupNativeMocks } from './bot-group-native-runtime.test-fixture'
import { BotGroupRuntime, markBotGroupRoomUnread } from './bot-group-runtime'
import { migrateBotGroupHomes } from './bot-group-home-migration'

const mocks = groupNativeMocks()
const closed = () => mocks.close.mock.calls.map(([sessionId]) => sessionId)

describe('group lifecycle', () => {
  it('removes deleted bots and keeps the room readable after its last member leaves', async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const message = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: 'hello'
    })
    await groups.removeBot('bot-0')
    const current = groups.store.get(group.id)
    expect(current.members.map((member) => member.botId)).toEqual(['bot-1'])
    expect(current.replyMode).toEqual({ kind: 'mentions' })
    expect(current.folderWorkspaceId).toBe(group.folderWorkspaceId)
    expect(groups.store.message(message.id)?.turns[0].revoked).toBe(true)
    expect(closed()).toEqual([group.members[0].sessionId])
    await expect(
      groups.send({
        groupId: group.id,
        revision: current.revision,
        messageId: randomUUID(),
        text: 'hey @Forge can you look'
      })
    ).resolves.toMatchObject({ turns: [{ botId: 'bot-1' }] })
    await groups.removeBot('bot-1')
    const { group: empty } = groups.read(group.id)
    expect(empty.members).toEqual([])
    expect(empty.folderWorkspaceId).toBe(group.folderWorkspaceId)
    expect(closed()).toEqual(group.members.map((member) => member.sessionId))
    await expect(
      groups.send({
        groupId: group.id,
        revision: empty.revision,
        messageId: randomUUID(),
        text: 'anyone?'
      })
    ).rejects.toThrow(/left this group/)
  })

  it('deletes a room, its rows, its sessions and its home', async () => {
    const { groups, runtime, homes } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const kept = await groups.create({ name: 'Kept', botIds: ['bot-0'] })
    const message = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: '@everyone hi'
    })
    mocks.close.mockClear()
    await groups.delete(group.id)
    expect(groups.store.list().map((entry) => entry.id)).toEqual([kept.id])
    expect(groups.store.message(message.id)).toBeNull()
    expect(groups.store.operationMessage(message.turns[0].operationId)).toBeNull()
    expect(closed()).toEqual(group.members.map((m) => m.sessionId))
    expect(homes.remove).toHaveBeenCalledWith(group.folderWorkspaceId)
    expect(() => groups.read(group.id)).toThrow(/not found/)
    expect(runtime.notifyBotGroupsChanged).toHaveBeenCalled()
  })

  it('closes the sessions it started when create or update fails', async () => {
    const { groups, homes } = fixture()
    mocks.create.mockImplementation(async (_runtime, bot, input) => {
      if (bot.id === 'bot-1') {
        throw new Error('no provider')
      }
      return input.sessionId
    })
    await expect(groups.create({ name: 'R', botIds: ['bot-0', 'bot-1'] })).rejects.toThrow(
      /no provider/
    )
    expect(closed()).toHaveLength(1)
    expect(closed()[0]).toMatch(/^bot-group-member-/)
    mocks.close.mockClear()
    mocks.create.mockImplementation(async (_runtime, _bot, input) => input.sessionId)
    homes.create.mockRejectedValueOnce(new Error('no home'))
    await expect(groups.create({ name: 'R', botIds: ['bot-0', 'bot-1'] })).rejects.toThrow(
      /no home/
    )
    expect(closed()).toHaveLength(2)
    expect(groups.store.list()).toEqual([])

    const group = await groups.create({ name: 'R', botIds: ['bot-0', 'bot-1'] })
    mocks.close.mockClear()
    mocks.snapshot.mockRejectedValueOnce(new Error('journal unavailable'))
    await expect(
      groups.update({ groupId: group.id, revision: group.revision, botIds: ['bot-1', 'bot-2'] })
    ).rejects.toThrow(/journal unavailable/)
    expect(closed()).toHaveLength(1)
    expect(closed()[0]).not.toBe(group.members[0].sessionId)
    expect(groups.store.get(group.id)).toEqual(group)
  })

  it('resumes every room’s owed deliveries once the runtime starts', async () => {
    const { groups, runtime } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0'] })
    const [member] = group.members
    groups.store.append(
      {
        id: 'owed',
        groupId: group.id,
        author: { kind: 'owner' },
        text: 'left behind by a crash',
        createdAt: 1,
        turns: [
          {
            operationId: 'owed-op',
            botId: member.botId,
            botName: 'Scout',
            avatar: null,
            agent: 'claude',
            sessionId: member.sessionId
          }
        ]
      },
      new Map([['owed-op', '[]']])
    )
    new BotGroupRuntime(runtime).resumePending()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    expect(mocks.send.mock.calls[0][0].turn.operationId).toBe('owed-op')
    await vi.waitFor(() => expect(groups.store.pending()).toEqual([]))
  })

  it('starts no new turn until a Stop’s delayed cancel has finished', async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Solo', botIds: ['bot-0'] })
    let release = () => {}
    mocks.cancel.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ ok: true })))
    )
    const stopping = groups.stop(group.id)
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(1))
    const sending = groups.send({
      groupId: group.id,
      revision: groups.store.get(group.id).revision,
      messageId: randomUUID(),
      text: 'hello after stop'
    })
    // A full macrotask turn: the queued send has run as far as it can before the cancel settles.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(groups.store.messages(group.id)).toEqual([])
    expect(mocks.send).not.toHaveBeenCalled()
    release()
    await stopping
    const message = await sending
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    expect(mocks.send.mock.calls[0][0].turn.operationId).toBe(message.turns[0].operationId)
  })

  it('quotes a retired member’s frozen reply and owes nothing for its unsent turn', async () => {
    const { groups } = fixture()
    let group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const asked = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: '@Scout look'
    })
    const operationId = asked.turns[0].operationId
    const key = agentJournalSubmissionKey(operationId)
    const at = { sequence: 1, revision: 1, observedAt: 1 }
    mocks.snapshot.mockImplementation(async (sessionId) => ({
      sessionId,
      cursor: { epoch: 'e', sequence: 1 },
      submissions: [],
      items:
        sessionId === group.members[0].sessionId
          ? [
              { ...at, itemId: key, body: { kind: 'message', role: 'user', blocks: [] } },
              {
                ...at,
                itemId: 'turn',
                body: { kind: 'turn', turnId: 't', state: 'completed', userItemId: key }
              },
              {
                ...at,
                itemId: 'reply',
                turnScope: { kind: 'turn', turnItemId: 'turn' },
                body: {
                  kind: 'message',
                  role: 'assistant',
                  blocks: [{ type: 'text', text: 'Scout found it' }]
                }
              }
            ]
          : []
    }))
    groups.store.append(
      {
        id: 'owed',
        groupId: group.id,
        author: { kind: 'owner' },
        text: 'reserved before a crash',
        createdAt: 1,
        turns: [{ ...asked.turns[0], operationId: 'owed-op' }]
      },
      new Map([['owed-op', '[]']])
    )
    group = await groups.update({ groupId: group.id, revision: group.revision, botIds: ['bot-1'] })
    expect(groups.store.pending()).toEqual([])
    const next = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: '@Forge continue'
    })
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
    expect(mocks.send.mock.calls[1][0].turn.operationId).toBe(next.turns[0].operationId)
    expect(JSON.stringify(mocks.send.mock.calls[1][0].turn.body)).toContain('Scout found it')
  })

  it('gives a group saved with a spare anchor session its own home on start', async () => {
    const { groups, db, homes } = fixture()
    const legacy = {
      id: 'old-room',
      name: 'Old',
      hostId: 'local',
      revision: 3,
      workspaceId: 'folder:folder-0',
      anchorSessionId: 'bot-group-room-old-room',
      members: [{ botId: 'bot-0', sessionId: 'bot-group-member-old' }],
      replyMode: { kind: 'all' },
      createdAt: 1
    }
    db.prepare('INSERT INTO bot_groups(id, record) VALUES (?, ?)').run(
      legacy.id,
      JSON.stringify(legacy)
    )
    expect(groups.store.list()).toEqual([])
    await migrateBotGroupHomes(groups)
    expect(homes.create).toHaveBeenCalledWith('Old', 'claude')
    expect(groups.store.legacy()).toEqual([])
    expect(groups.store.get('old-room')).toEqual({
      id: 'old-room',
      name: 'Old',
      hostId: 'local',
      revision: 4,
      folder: 'group-old-1',
      folderWorkspaceId: 'group-home-1',
      members: legacy.members,
      replyMode: { kind: 'all' },
      createdAt: 1
    })
    expect(closed()).toEqual(['bot-group-room-old-room'])
  })

  it('marks only the room a member replied in unread, through its home', async () => {
    const { groups, runtime, homes } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    await groups.create({ name: 'Other', botIds: ['bot-0'] })
    markBotGroupRoomUnread(runtime, group.members[1].sessionId)
    markBotGroupRoomUnread(runtime, 'bot-session-not-in-a-room')
    expect(homes.update.mock.calls).toEqual([
      [group.folderWorkspaceId, { isUnread: true, lastActivityAt: expect.any(Number) }]
    ])
  })
})
