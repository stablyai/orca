import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { fixture, groupNativeMocks } from './bot-group-native-runtime.test-fixture'
import { noteBotGroupMemberReply } from './bot-group-latest'

const mocks = groupNativeMocks()

describe('a group as the sidebar lists it', () => {
  it("lists the owner's post as the room's newest, on one line", async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const sent = await groups.send({
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: '@Scout  look\n\nat this'
    })
    expect(groups.store.listing()[0]?.latest).toEqual({
      authorName: null,
      text: '@Scout look at this',
      at: sent.createdAt
    })
    // The record itself never holds what the listing adds.
    expect(groups.store.get(group.id)).not.toHaveProperty('latest')
  })

  it("lists a member's reply and quotes it to the next member without a second read", async () => {
    const { groups, runtime } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
    const send = (text: string) =>
      groups.send({ groupId: group.id, revision: group.revision, messageId: randomUUID(), text })
    const asked = await send('@Scout look')
    mocks.snapshot.mockImplementation(async (sessionId) =>
      journal(sessionId, [
        { operationId: asked.turns[0]!.operationId, text: 'Found it', at: asked.createdAt }
      ])
    )
    await noteBotGroupMemberReply(runtime, group.members[0]!.sessionId)
    expect(groups.store.listing()[0]?.latest).toMatchObject({
      authorName: 'Scout',
      text: 'Found it',
      at: asked.createdAt
    })
    mocks.snapshot.mockReset()
    mocks.snapshot.mockRejectedValue(new Error('a member chat was read'))

    const next = await send('@Forge what do you think?')

    expect(groups.store.message(asked.id)?.turns[0]?.reply).toBe('Found it')
    expect(groups.store.pendingContext(next.turns[0]!.operationId)).toContain('Found it')
  })

  it('saves that a turn ended without a reply, so later posts stop reading its chat', async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0'] })
    // Mentions only, so the posts after it start no turns of their own.
    groups.store.put({ ...group, replyMode: { kind: 'mentions' } })
    const send = (text: string) =>
      groups.send({ groupId: group.id, revision: group.revision, messageId: randomUUID(), text })
    // Stopped before it said anything, with nothing saved when it ended.
    const asked = await send('@Scout look')
    const operationId = asked.turns[0]!.operationId
    const stopped = journal(group.members[0]!.sessionId, [{ operationId, text: '', at: 0 }])
    mocks.snapshot.mockImplementation(async () => ({
      ...stopped,
      items: stopped.items
        .filter((item) => !(item.body.kind === 'message' && item.body.role === 'assistant'))
        .map((item) =>
          item.body.kind === 'turn'
            ? { ...item, body: { ...item.body, state: 'stopped' as const, completedAt: undefined } }
            : item
        )
    }))
    await send('one')
    mocks.snapshot.mockReset()
    mocks.snapshot.mockRejectedValue(new Error('a member chat was read'))

    await expect(send('two')).resolves.toBeDefined()
    expect(groups.store.message(asked.id)?.turns[0]?.reply).toBeNull()
  })

  it('lists the reply that finished, not a newer post still queued to the same member', async () => {
    const { groups, runtime } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0'] })
    const send = (text: string) =>
      groups.send({ groupId: group.id, revision: group.revision, messageId: randomUUID(), text })
    const first = await send('@Scout one')
    const second = await send('@Scout two')
    mocks.snapshot.mockImplementation(async (sessionId) =>
      journal(sessionId, [
        { operationId: first.turns[0]!.operationId, text: 'First done', at: second.createdAt + 1 }
      ])
    )
    await noteBotGroupMemberReply(runtime, group.members[0]!.sessionId)
    expect(groups.store.listing()[0]?.latest).toMatchObject({
      authorName: 'Scout',
      text: 'First done'
    })
  })

  it("lists a member's reply however many posts came after its own", async () => {
    const { groups, runtime } = fixture()
    const created = await groups.create({ name: 'Review', botIds: ['bot-0'] })
    // Mentions only, so the posts after it start no turns.
    groups.store.put({ ...created, replyMode: { kind: 'mentions' } })
    const send = (text: string) =>
      groups.send({
        groupId: created.id,
        revision: created.revision,
        messageId: randomUUID(),
        text
      })
    const asked = await send('@Scout original')
    let last = asked
    for (let index = 0; index < 501; index++) {
      last = await send(`post-${index}`)
    }
    mocks.snapshot.mockImplementation(async (sessionId) =>
      journal(sessionId, [
        { operationId: asked.turns[0]!.operationId, text: 'Finished reply', at: last.createdAt }
      ])
    )
    await noteBotGroupMemberReply(runtime, created.members[0]!.sessionId)
    expect(groups.store.listing()[0]?.latest).toMatchObject({
      authorName: 'Scout',
      text: 'Finished reply'
    })
  })

  it('keeps an owner post saved in the same millisecond after the reply ended', async () => {
    const { groups, runtime } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0'] })
    const send = (text: string) =>
      groups.send({ groupId: group.id, revision: group.revision, messageId: randomUUID(), text })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const asked = await send('@Scout one')
      const pending: (() => void)[] = []
      mocks.snapshot.mockImplementationOnce(
        (sessionId) =>
          new Promise((resolve) => {
            pending.push(() =>
              resolve(
                journal(sessionId, [
                  { operationId: asked.turns[0]!.operationId, text: 'Finished reply', at: 1_000 }
                ])
              )
            )
          })
      )
      const noting = noteBotGroupMemberReply(runtime, group.members[0]!.sessionId)
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      await send('Newer owner post')
      for (const resolve of pending) {
        resolve()
      }
      await noting
    } finally {
      clock.mockRestore()
    }
    expect(groups.store.listing()[0]?.latest).toMatchObject({
      authorName: null,
      text: 'Newer owner post'
    })
  })

  it('keeps the newest same-millisecond reply as reads finish in and out of order', async () => {
    const { groups, runtime } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1', 'bot-2'] })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const asked = await groups.send({
        groupId: group.id,
        revision: group.revision,
        messageId: randomUUID(),
        text: '@Scout @Forge @Sage compare plans'
      })
      await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(3))
      const [scout, forge, sage] = asked.turns
      const pending = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      mocks.snapshot.mockImplementationOnce(async (sessionId) => {
        started.resolve()
        await pending.promise
        return journal(sessionId, [
          { operationId: scout.operationId, text: 'Scout reply', at: 1_000 }
        ])
      })
      const olderRead = noteBotGroupMemberReply(runtime, scout.sessionId)
      await started.promise

      try {
        for (const [turn, reply] of [
          [forge, 'Forge reply'],
          [sage, 'Sage reply']
        ] as const) {
          mocks.snapshot.mockImplementationOnce(async (sessionId) =>
            journal(sessionId, [{ operationId: turn.operationId, text: reply, at: 1_000 }])
          )
          await noteBotGroupMemberReply(runtime, turn.sessionId)
          expect(groups.store.listing()[0]?.latest).toMatchObject({ text: reply })
        }
      } finally {
        pending.resolve()
        await olderRead
      }
      expect(groups.store.listing()[0]?.latest).toMatchObject({
        authorName: 'Sage',
        text: 'Sage reply'
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps its sidebar place through a membership edit and forgets it on delete', async () => {
    const { groups } = fixture()
    const group = await groups.create({ name: 'Review', botIds: ['bot-0'] })
    groups.store.setSidebarOrder(group.id, 4)
    await groups.update({ groupId: group.id, revision: group.revision, botIds: ['bot-0', 'bot-1'] })
    expect(groups.store.listing()[0]?.sidebarOrder).toBe(4)
    await groups.delete(group.id)
    groups.store.put({ ...group })
    expect(groups.store.listing()[0]).not.toHaveProperty('sidebarOrder')
  })
})

/** A member's journal with each given operation answered and completed at its time. */
function journal(sessionId: string, replies: { operationId: string; text: string; at: number }[]) {
  const stamp = { sequence: 1, revision: 1, observedAt: 1 }
  return {
    sessionId,
    cursor: { epoch: 'e', sequence: 1 },
    // Each operation's send, accepted, so its turn maps back to the operation.
    submissions: replies.map(({ operationId }) => ({
      clientMessageId: operationId,
      fence: 1,
      payloadFingerprint: operationId,
      dispatchState: 'accepted' as const,
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: 1
    })),
    items: replies.flatMap(({ operationId, text, at }) => {
      const key = agentJournalSubmissionKey(operationId)
      return [
        {
          ...stamp,
          itemId: key,
          body: { kind: 'message' as const, role: 'user' as const, blocks: [] }
        },
        {
          ...stamp,
          itemId: `turn-${operationId}`,
          body: {
            kind: 'turn' as const,
            turnId: `t-${operationId}`,
            state: 'completed' as const,
            userItemId: key,
            completedAt: at
          }
        },
        {
          ...stamp,
          itemId: `reply-${operationId}`,
          turnScope: { kind: 'turn' as const, turnItemId: `turn-${operationId}` },
          body: {
            kind: 'message' as const,
            role: 'assistant' as const,
            blocks: [{ type: 'text' as const, text }]
          }
        }
      ]
    })
  }
}
