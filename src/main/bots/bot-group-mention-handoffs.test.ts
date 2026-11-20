import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { BotGroupMessage } from '../../shared/bots/bot-group'
import { fixture, groupNativeMocks, journal } from './bot-group-native-runtime.test-fixture'
import { noteBotGroupMemberReply } from './bot-group-latest'

const mocks = groupNativeMocks()

/** A room of Scout and Forge whose members' chats answer with the replies `reply` records. */
async function room() {
  const { groups, runtime } = fixture()
  const created = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
  groups.store.put({ ...created, replyMode: { kind: 'mentions' } })
  const replies = new Map<string, { operationId: string; text: string; at: number }[]>()
  mocks.snapshot.mockImplementation(async (sessionId) =>
    journal(sessionId, replies.get(sessionId) ?? [])
  )
  let at = 1
  const post = (text: string) =>
    groups.send({
      groupId: created.id,
      revision: groups.store.get(created.id).revision,
      messageId: randomUUID(),
      text
    })
  /** The turn's member finishes it with `text` in its chat. */
  const finish = async (message: BotGroupMessage, text: string) => {
    await vi.waitFor(() => expect(groups.store.pending()).toEqual([]))
    const turn = message.turns[0]!
    replies.set(turn.sessionId, [
      ...(replies.get(turn.sessionId) ?? []),
      { operationId: turn.operationId, text, at: at++ }
    ])
  }
  /** The chat reports the message's turn ended. */
  const ended = (message: BotGroupMessage) => {
    const turn = message.turns[0]!
    return noteBotGroupMemberReply(runtime, turn.sessionId, `t-${turn.operationId}`)
  }
  const reply = async (message: BotGroupMessage, text: string) => {
    await finish(message, text)
    await ended(message)
  }
  const lines = () => groups.store.messages(created.id, 100)
  const newest = () => lines().at(-1)!
  return { groups, runtime, group: created, post, finish, ended, reply, lines, newest }
}

describe('group @Name hand-offs', () => {
  it("wakes a member a reply names under the same person's post, never the speaker", async () => {
    const { runtime, post, reply, lines, newest } = await room()
    const asked = await post('@Scout plan the release')
    await reply(asked, 'Plan ready. @Scout notes for me; @forge please review.')
    const handoff = newest()
    expect(handoff).toMatchObject({
      author: { kind: 'bot', id: 'bot-0', name: 'Scout' },
      requester: { id: 'bot-0', name: 'Scout' },
      mentioned: true,
      rootRequestId: asked.id,
      rootSequence: asked.sequence
    })
    expect(handoff.turns.map((turn) => turn.botId)).toEqual(['bot-1'])
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
    const prompt: string = mocks.send.mock.calls[1]![0].turn.body.blocks[0].text
    expect(prompt).toContain(`Original human instruction (room message ${asked.id}`)
    expect(prompt).toContain('@Scout plan the release')
    expect(prompt).toContain('Plan ready.')
    // The same turn end reported again wakes no one twice.
    await noteBotGroupMemberReply(
      runtime,
      asked.turns[0]!.sessionId,
      `t-${asked.turns[0]!.operationId}`
    )
    expect(lines()).toHaveLength(2)
  })

  it('quotes the naming reply to a member whose history was taken after a later post', async () => {
    const { post, reply, newest } = await room()
    const asked = await post('@Scout plan')
    await post('@Forge something else')
    await reply(asked, 'Plan X is ready. @Forge review it.')
    const operationId = newest().turns[0]!.operationId
    await vi.waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        expect.objectContaining({ turn: expect.objectContaining({ operationId }) })
      )
    )
    const sent = mocks.send.mock.calls.find((call) => call[0].turn.operationId === operationId)
    const prompt: string = sent![0].turn.body.blocks[0].text
    expect(prompt).toContain('Plan X is ready.')
  })

  it('ignores names in code and pauses once after six hand-offs until a person posts', async () => {
    const { post, reply, lines, newest } = await room()
    await reply(await post('@Scout start'), 'Run `@Forge` first.')
    expect(lines()).toHaveLength(1)
    await reply(await post('@Scout go'), '@Forge your turn')
    for (let hop = 0; hop < 6; hop++) {
      await reply(newest(), hop % 2 === 0 ? '@Scout yours' : '@Forge yours')
    }
    const after = lines().slice(2)
    expect(after.filter((line) => line.mentioned)).toHaveLength(6)
    expect(after.at(-1)).toMatchObject({ pausedAfter: 6, turns: [] })

    const fresh = await post('@Forge continue')
    await reply(fresh, '@Scout over to you')
    expect(newest()).toMatchObject({ mentioned: true, rootRequestId: fresh.id })
  })

  it("leaves an explicit peer request's reply and a stopped room unwoken", async () => {
    const { groups, group, post, reply, lines } = await room()
    const asked = await post('@Scout look')
    await groups.stop(group.id)
    await reply(asked, '@Forge check this')
    expect(lines()).toHaveLength(1)

    const next = await post('@Scout again')
    const [scout] = groups.store.get(group.id).members
    groups.store.append({
      id: 'mail-line',
      groupId: group.id,
      author: { kind: 'bot', id: 'bot-0', name: 'Scout' },
      text: 'Forge asked Scout',
      createdAt: next.createdAt,
      rootRequestId: next.id,
      rootSequence: next.sequence,
      turns: [
        { ...next.turns[0]!, operationId: 'mail-op', sessionId: scout!.sessionId, mailbox: true }
      ]
    })
    await reply(groups.store.message('mail-line')!, '@Forge answered')
    expect(lines().map((line) => line.id)).toEqual([asked.id, next.id, 'mail-line'])
  })

  it('reads the turn the end names, though a later turn of the same member ended first', async () => {
    const { post, finish, ended, newest } = await room()
    const first = await post('@Scout plan')
    const second = await post('@Scout tidy up')
    await finish(first, '@Forge review the plan')
    await finish(second, 'Tidied.')
    await ended(first)
    expect(newest()).toMatchObject({ mentioned: true, rootRequestId: first.id })
  })

  it('reads mentions in the whole reply, past the room history cut', async () => {
    const { post, reply, newest } = await room()
    const asked = await post('@Scout write it up')
    await reply(asked, `@Forge review this.\n\n${'detail '.repeat(4_000)}`)
    expect(newest().turns.map((turn) => turn.botId)).toEqual(['bot-1'])
  })

  it('reserves nothing when the hand-off cannot all be saved', async () => {
    const { groups, post, reply, lines } = await room()
    const asked = await post('@Scout plan')
    // A line already under the woken line's id makes its save fail midway.
    groups.store.append({
      id: `handoff:${asked.turns[0]!.operationId}:bot-1`,
      groupId: 'elsewhere',
      author: { kind: 'owner' },
      text: '',
      createdAt: asked.createdAt,
      turns: []
    })
    await expect(reply(asked, '@Forge review')).rejects.toThrow()
    const saved = groups.store.message(asked.id)
    expect(saved?.handoffs).toBeUndefined()
    expect(saved?.turns[0]?.handedOff).toBeUndefined()
    expect(groups.store.pending()).toEqual([])
    expect(lines()).toHaveLength(1)
  })

  it('wakes no one again when the same end replays after the named member is replaced', async () => {
    const { groups, group, post, ended, reply, lines } = await room()
    const asked = await post('@Scout plan')
    await reply(asked, '@Forge review')
    expect(lines()).toHaveLength(2)
    const sage = groups.runtime.bots.list().find((bot) => bot.id === 'bot-2')!
    await groups.update({
      groupId: group.id,
      revision: groups.store.get(group.id).revision,
      botIds: ['bot-0', 'bot-2']
    })
    sage.name = 'Forge'
    await ended(asked)
    expect(lines()).toHaveLength(2)
  })
})
