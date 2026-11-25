import { expect, it } from 'vitest'
import { originalResource } from './feishu-resources'
import { feishuReplyMessage } from './feishu-replies'
import { dmKey } from './feishu-binding'
import { FeishuInbox } from './feishu-inbox'

const verified = {
  account: 'example-account',
  bot: 'example-bot',
  profile: 'example',
  app: 'cli_example',
  owner: 'ou_owner',
  chat: 'oc_owner',
  pairedAt: 1
}
const original = {
  message_id: 'om_picture',
  chat_id: verified.chat,
  msg_type: 'image',
  sender: { id_type: 'open_id', sender_type: 'user', id: verified.owner },
  body: { content: JSON.stringify({ image_key: 'img_example' }) }
}
const reply = (item: unknown, identity = 'bot') => ({ ok: true, identity, data: { items: [item] } })

it('accepts a resource only under the original human, DM, message, bot identity and resource type', () => {
  const read = (value: unknown) => originalResource(value, verified, original.message_id, 'image')
  expect(read(reply(original))?.key).toBe('img_example')
  for (const item of [
    { ...original, message_id: 'om_another' },
    { ...original, chat_id: 'oc_another' },
    { ...original, msg_type: 'file' },
    { ...original, sender: { ...original.sender, id: 'ou_other' } },
    { ...original, sender: { ...original.sender, sender_type: 'app' } },
    { ...original, body: { content: JSON.stringify({ file_key: 'file_example' }) } },
    { ...original, body: { content: 'invalid' } }
  ]) {
    expect(read(reply(item))).toBeNull()
  }
  expect(read(reply(original, 'user'))).toBeNull()
})

it('leaves external image references in plain text without activating card resources', () => {
  for (const text of [
    '![photo](https://example.org/test.png)',
    '<IMG src="https://example.org/test.png">'
  ]) {
    expect(feishuReplyMessage(text, 'Example')).toEqual({ type: 'text', content: { text } })
  }
})

it('keeps identically named original messages and generated uploads separate across two apps', () => {
  const db = new FeishuInbox(':memory:')
  try {
    const event = {
      type: 'im.message.receive_v1',
      chat_type: 'p2p',
      message_type: 'text',
      create_time: '1800000000001',
      event_id: 'pair',
      message_id: 'om_pair',
      sender_id: 'ou_example',
      chat_id: 'oc_example',
      content: 'example'
    } as const
    for (const name of ['alpha', 'beta']) {
      const b = db.add('scope', name, { name, brand: 'feishu', appId: `cli_${name}` })
      db.pair('scope', b, event)
    }
    const [first, second] = db.bindings('scope')
    expect(dmKey(first)).not.toEqual(dmKey(second))
    for (const b of [first, second]) {
      db.accept(b, {
        ...event,
        create_time: '1800000000002',
        message_id: 'om_original',
        event_id: 'original'
      })
    }
    const mid = 'om_original'
    const bytes = Buffer.from('synthetic')
    db.stageFile(first.account, mid, 'receipt.txt', bytes)
    db.stageFile(first.account, mid, 'receipt.txt', bytes)
    expect(() => db.stageFile(first.account, mid, 'other.txt', bytes)).toThrow()
    expect(db.artifact(second.account, mid)).toBeUndefined()
    expect(db.takeProgress(first.account, mid)).toBe(true)
    expect(db.takeProgress(first.account, mid)).toBe(false)
    expect(db.takeProgress(second.account, mid)).toBe(true)
    db.uploaded(first.account, mid, 'file_example')
    expect(db.artifact(first.account, mid)).toMatchObject({
      bytes: null,
      key: 'file_example',
      posted: 0
    })
    db.filePosted(first.account, mid)
    expect(db.artifact(first.account, mid)?.posted).toBe(1)
    db.remove('scope', first.bot, first.account)
    expect(db.artifact(first.account, mid)).toBeUndefined()
    expect(db.next(second.account)?.mid).toBe(mid)
  } finally {
    db.close()
  }
})
