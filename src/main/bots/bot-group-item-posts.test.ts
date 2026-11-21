import { describe, expect, it, vi } from 'vitest'
import { fixture, groupNativeMocks } from './bot-group-native-runtime.test-fixture'
import { groupItemPostId, postGroupItemMail } from './bot-group-item-posts'
import { BOT_GROUP_CHANGED } from './bot-group-delivery'

const mocks = groupNativeMocks()

const ANSWER = {
  id: 'msg_item_e11',
  subject: 'Your owner answered your question (item 3)',
  // Names the other member, as an answer may: only the bot that asked wakes.
  body: `Your owner changed item 3:\n- item 3: answered your question: ask @Scout first (event e11)\n${'Long detail. '.repeat(2_000)}`,
  images: []
}

async function room() {
  const setup = fixture()
  const group = await setup.groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
  return { ...setup, group, scout: group.members[0], forge: group.members[1] }
}

const delivered = () =>
  mocks.send.mock.calls.map(([input]) => (input as { sessionId: string }).sessionId)

describe("an owner's item answer in a group room", () => {
  it('posts it as the owner to the bot that asked alone, named and in full', async () => {
    const { groups, group, forge } = await room()
    expect(await postGroupItemMail(groups, forge.sessionId, ANSWER)).toBe(true)
    expect(groups.store.message(groupItemPostId(ANSWER.id))).toMatchObject({
      groupId: group.id,
      author: { kind: 'owner' },
      text: `@Forge ${ANSWER.subject}\n\n${ANSWER.body}`,
      turns: [{ botId: 'bot-1', sessionId: forge.sessionId }]
    })
    // Admitted before it answers, so the change is settled only once the turn is in.
    expect(delivered()).toEqual([forge.sessionId])
  })

  it('posts it once, even when the item was retitled or the bot left before a retry', async () => {
    const { groups, group, forge } = await room()
    await postGroupItemMail(groups, forge.sessionId, ANSWER)
    const retitled = { ...ANSWER, subject: 'Your owner answered your question (item 3: renamed)' }
    expect(await postGroupItemMail(groups, forge.sessionId, retitled)).toBe(true)
    await groups.update({
      groupId: group.id,
      revision: groups.store.get(group.id).revision,
      botIds: ['bot-0']
    })
    expect(await postGroupItemMail(groups, forge.sessionId, ANSWER)).toBe(true)
    expect(
      groups.store.messages(group.id).filter((message) => message.id.startsWith('item-mail:'))
    ).toHaveLength(1)
    expect(delivered()).toEqual([forge.sessionId])
  })

  it('still wakes the bot when the room was stopped before the answer', async () => {
    const { groups, group, scout } = await room()
    await groups.stop(group.id)
    expect(await postGroupItemMail(groups, scout.sessionId, ANSWER)).toBe(true)
    expect(delivered()).toEqual([scout.sessionId])
  })

  it('sends it Home when the room refuses the turn, and never admits it twice', async () => {
    const { groups, scout } = await room()
    mocks.send.mockResolvedValueOnce({ kind: 'refused', refusal: { message: 'The chat is busy.' } })
    expect(await postGroupItemMail(groups, scout.sessionId, ANSWER)).toBe(false)
    // A retry (after a restart, say) finds the refused post and sends it Home again, not to the room.
    expect(await postGroupItemMail(groups, scout.sessionId, ANSWER)).toBe(false)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('reads the room again when it changed while posting', async () => {
    const { groups, scout } = await room()
    const send = groups.send
    const changed = vi
      .spyOn(groups, 'send')
      .mockRejectedValueOnce(new Error(BOT_GROUP_CHANGED))
      .mockImplementation(send)
    expect(await postGroupItemMail(groups, scout.sessionId, ANSWER)).toBe(true)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(delivered()).toEqual([scout.sessionId])
  })

  it('throws the stale-revision error it retries on, word for word', async () => {
    const { groups, group } = await room()
    await expect(
      groups.send({ groupId: group.id, revision: group.revision - 1, messageId: 'm', text: 'hi' })
    ).rejects.toThrow(new Error(BOT_GROUP_CHANGED))
  })

  it('answers with a post the send stored before it failed, delivering it and never going Home', async () => {
    const { groups, group, scout } = await room()
    vi.spyOn(groups.store, 'setLatest').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(await postGroupItemMail(groups, scout.sessionId, ANSWER)).toBe(true)
    expect(groups.store.messages(group.id)).toHaveLength(1)
    expect(delivered()).toEqual([scout.sessionId])
  })

  it('posts nothing for a session no room has, so the answer goes to Home', async () => {
    const { groups } = await room()
    expect(await postGroupItemMail(groups, 'bot-group-member-gone', ANSWER)).toBe(false)
  })
})
