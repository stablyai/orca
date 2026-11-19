import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { findBotGroupRoomOfSession } from '../../shared/bots/bot-group'
import { fixture, groupNativeMocks } from './bot-group-native-runtime.test-fixture'

const mocks = groupNativeMocks()

describe('group threads', () => {
  it('runs a thread on fresh member sessions, with its own history and deliveries', async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const all = await groups.update({
      groupId: group.id,
      revision: group.revision,
      replyMode: { kind: 'all' }
    })
    await groups.send({
      groupId: group.id,
      revision: all.revision,
      messageId: randomUUID(),
      text: 'Main room plan'
    })
    const { threadId, group: withThread } = await groups.newThread(group.id)
    const threadSessions = withThread.threads?.[0]?.members.map((member) => member.sessionId)
    expect(threadSessions).toHaveLength(2)
    expect(threadSessions?.some((id) => all.members.some((m) => m.sessionId === id))).toBe(false)

    mocks.send.mockClear()
    const posted = await groups.send({
      groupId: group.id,
      threadId,
      revision: all.revision,
      messageId: randomUUID(),
      text: 'Release notes\nfor 1.4'
    })
    expect(posted.threadId).toBe(threadId)
    expect(posted.turns.map((turn) => turn.sessionId)).toEqual(threadSessions)
    // The main room's post is not in the thread's context.
    expect(posted.turns.map((turn) => groups.store.pendingContext(turn.operationId))).toEqual([
      '[]',
      '[]'
    ])
    await expect.poll(() => mocks.send.mock.calls.length).toBe(2)
    expect(mocks.send.mock.calls.map(([send]) => send.sessionId)).toEqual(threadSessions)

    expect(groups.read(group.id).messages.map((message) => message.text)).toEqual([
      'Main room plan'
    ])
    const thread = groups.read(group.id, undefined, threadId)
    expect(thread.messages.map((message) => message.text)).toEqual(['Release notes\nfor 1.4'])
    expect(thread.group.members.map((member) => member.sessionId)).toEqual(threadSessions)
    expect(groups.store.get(group.id).threads?.[0]?.title).toBe('Release notes for 1.4')
  })

  it('stops only the thread it is asked to', async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const { threadId } = await groups.newThread(group.id)
    await groups.send({
      groupId: group.id,
      threadId,
      revision: group.revision,
      messageId: randomUUID(),
      text: '@everyone go'
    })
    await groups.stop(group.id, undefined, threadId)
    const current = groups.store.get(group.id)
    const thread = current.threads?.[0]
    expect(mocks.cancel.mock.calls.map((call) => call[1].envelope.sessionId)).toEqual(
      thread?.members.map((member) => member.sessionId)
    )
    expect(thread?.members.every((member) => (member.stoppedThroughSequence ?? 0) > 0)).toBe(true)
    expect(current.members.every((member) => member.stoppedThroughSequence === undefined)).toBe(
      true
    )
  })

  it('opens and retires member sessions in each room while preserving history', async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0'] })
    const { threadId } = await groups.newThread(group.id)
    const joined = await groups.update({
      groupId: group.id,
      revision: group.revision,
      botIds: ['bot-0', 'bot-2']
    })
    const thread = joined.threads?.find((entry) => entry.id === threadId)
    expect(thread?.members.map((member) => member.botId)).toEqual(['bot-0', 'bot-2'])
    expect(thread?.members[1]?.sessionId).not.toBe(joined.members[1]?.sessionId)
    const joinedInThread = thread?.members[1]?.sessionId ?? ''
    expect(groups.store.memberOf(joinedInThread)?.threadId).toBe(threadId)

    mocks.close.mockClear()
    const joinedInMain = joined.members[1].sessionId
    const retired = await groups.update({
      groupId: group.id,
      revision: joined.revision,
      botIds: ['bot-0']
    })
    expect(mocks.close.mock.calls.map(([sessionId]) => sessionId).toSorted()).toEqual(
      [joinedInMain, joinedInThread].toSorted()
    )
    expect(findBotGroupRoomOfSession([retired], joinedInThread)?.threadId).toBe(threadId)
    expect(findBotGroupRoomOfSession([retired], joinedInMain)).toMatchObject({
      group: { id: group.id },
      threadId: undefined
    })
    expect(groups.store.memberOf(joinedInThread)).toBeNull()
    mocks.close.mockClear()
    await groups.delete(group.id)
    expect(mocks.close).toHaveBeenCalledTimes(2)
  })
})
