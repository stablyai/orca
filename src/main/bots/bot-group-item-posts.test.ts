import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { BOT_ITEM_MAIL_SENDER } from '../../shared/bots/bot-item-note-runs'
import { fixture, groupNativeMocks } from './bot-group-native-runtime.test-fixture'
import { groupItemPostId, postGroupItemMail } from './bot-group-item-posts'

const mocks = groupNativeMocks()

const ANSWER = {
  id: 'msg_item_e11',
  subject: 'Your owner answered your question (item 3)',
  body: `Your owner changed item 3:\n- item 3: answered your question "Ship Friday" (event e11)\n${'Long detail. '.repeat(2_000)}`,
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
  it('posts it as the owner to that bot alone, in full, and wakes only that bot', async () => {
    const { groups, group, scout } = await room()
    expect(await postGroupItemMail(groups, scout.sessionId, ANSWER)).toBe(true)
    const post = groups.store.message(groupItemPostId(ANSWER.id))
    expect(post).toMatchObject({
      groupId: group.id,
      author: { kind: 'owner' },
      text: `${ANSWER.subject}\n\n${ANSWER.body}`,
      turns: [{ botId: 'bot-0', sessionId: scout.sessionId }]
    })
    await vi.waitFor(() => expect(delivered()).toEqual([scout.sessionId]))
  })

  it('posts it once, however often the answer is sent again', async () => {
    const { groups, group, scout } = await room()
    await postGroupItemMail(groups, scout.sessionId, ANSWER)
    await postGroupItemMail(groups, scout.sessionId, ANSWER)
    await vi.waitFor(() => expect(groups.store.pending()).toEqual([]))
    expect(groups.store.messages(group.id)).toHaveLength(1)
    expect(delivered()).toEqual([scout.sessionId])
  })

  it('still wakes the bot when the room was stopped before the answer', async () => {
    const { groups, group, scout } = await room()
    await groups.stop(group.id)
    await postGroupItemMail(groups, scout.sessionId, ANSWER)
    await vi.waitFor(() => expect(delivered()).toEqual([scout.sessionId]))
  })

  it('posts nothing for a session no room has, so the answer goes to Home', async () => {
    const { groups } = await room()
    expect(await postGroupItemMail(groups, 'bot-group-member-gone', ANSWER)).toBe(false)
  })

  it('runs an answer an older Orca left unread in the room session once, then marks it read', async () => {
    const { groups, group, orchestration, scout } = await room()
    orchestration.insertMessage({
      id: ANSWER.id,
      from: BOT_ITEM_MAIL_SENDER,
      to: `orca_session_id:${scout.sessionId}`,
      subject: ANSWER.subject,
      body: ANSWER.body,
      type: 'status',
      orcaAuthored: 'item-mail'
    })
    const row = { id: ANSWER.id, thread_id: null, from_handle: BOT_ITEM_MAIL_SENDER }
    expect(groups.narrowMailBatch(scout.sessionId, [row])).toEqual({ messages: [], ended: [] })
    expect(groups.narrowMailBatch(scout.sessionId, [row])).toEqual({ messages: [], ended: [] })
    await vi.waitFor(() => expect(orchestration.getMessageById(ANSWER.id)?.read).toBe(1))
    await vi.waitFor(() => expect(groups.store.pending()).toEqual([]))
    expect(groups.store.message(groupItemPostId(ANSWER.id))?.author).toEqual({ kind: 'owner' })
    expect(groups.store.messages(group.id)).toHaveLength(1)
    expect(delivered()).toEqual([scout.sessionId])
  })

  it('leaves other room mail to the room rules', async () => {
    const { groups, scout } = await room()
    const row = { id: randomUUID(), thread_id: null, from_handle: 'term_someone' }
    expect(groups.narrowMailBatch(scout.sessionId, [row])).toEqual({ messages: [], ended: [] })
  })
})
