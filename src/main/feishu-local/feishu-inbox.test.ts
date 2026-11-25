import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { eligibleProfiles, readFeishuMessage } from './feishu-cli'
import { dmKey } from './feishu-binding'
import { FeishuInbox } from './feishu-inbox'
import { cloudConversation } from '../../shared/connectors/connector-cloud-contract'

const profile = { name: 'example', appId: 'cli_example', brand: 'feishu' }
const event = {
  type: 'im.message.receive_v1',
  chat_type: 'p2p',
  message_type: 'text',
  create_time: '1800000000000',
  event_id: 'event-one',
  message_id: 'om_first',
  chat_id: 'oc_one',
  sender_id: 'ou_one',
  content: 'Hello'
} as const

it('drops unsupported streams and rejects an alias that shadows a pinned app', () => {
  expect(readFeishuMessage(JSON.stringify(event))).toEqual(event)
  expect(readFeishuMessage(JSON.stringify({ ...event, chat_type: 'group' }))).toMatchObject({
    chat_type: 'group'
  })
  expect(readFeishuMessage(JSON.stringify({ ...event, message_type: 'post' }))).toBeNull()
  expect(readFeishuMessage(JSON.stringify({ ...event, sender_id: '' }))).toBeNull()
  expect(
    eligibleProfiles([profile, { ...profile, name: 'cli_example', appId: 'cli_other' }])
  ).not.toContainEqual(profile)
})

it('offers a shared app once under the profile the CLI actually resolves for its ID', () => {
  const alias = { ...profile, name: 'second-name' }
  expect(eligibleProfiles([profile, alias])).toEqual([profile])
  expect(eligibleProfiles([alias, profile])).toEqual([alias])
  expect(eligibleProfiles([profile, { ...alias, name: profile.appId }])).not.toContainEqual(profile)
  expect(eligibleProfiles([profile, { ...alias, name: profile.name }])).toEqual([])
})

it('keeps the pairing, actor, original DM and both replay keys bound across a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-inbox-'))
  const path = join(dir, 'inbox.sqlite')
  let inbox = new FeishuInbox(path)
  const other = new FeishuInbox(path)
  try {
    const b = inbox.add('first', 'bot', profile)
    expect(other.bindings('second')).toEqual([])
    expect(() => other.add('second', 'another', profile)).toThrow()
    expect(inbox.pair('first', b, event)).toBe(true)
    inbox.close()
    inbox = new FeishuInbox(path)
    const [bound] = inbox.bindings('first')
    expect(cloudConversation(dmKey(bound))).toBeNull()
    const next = { ...event, create_time: '1800000000100', message_id: 'om_next', event_id: 'next' }
    for (const denied of [
      event,
      { ...next, sender_id: 'ou_other' },
      { ...next, chat_id: 'oc_other' },
      { ...next, create_time: '1799999999999' }
    ]) {
      inbox.accept(bound, denied)
    }
    expect(inbox.next(b.account)).toBeUndefined()
    inbox.accept(bound, next)
    inbox.admitted(b.account, next.message_id)
    inbox.accept(bound, { ...next, message_id: 'om_another' })
    inbox.accept(bound, { ...next, event_id: 'other' })
    expect(inbox.next(b.account)).toBeUndefined()
    expect(inbox.mayPost(b.account, 'om_next', 1000)).toBe(true)
    expect(inbox.mayPost(b.account, 'om_next', 1000 + 55 * 60_000)).toBe(false)
    expect(inbox.mayPost(b.account, 'om_unknown', 1000)).toBe(false)
    other.remove('second', 'bot', b.account)
    expect(inbox.bindings('first')).toHaveLength(1)
    inbox.remove('first', 'bot', b.account)
    const replacement = inbox.add('first', 'bot', profile)
    inbox.remove('first', 'bot', b.account)
    expect(inbox.bindings('first')).toEqual([replacement])
  } finally {
    inbox.close()
    other.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('persists explicit replies and stops uncertain retries before the provider forgets their keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-replies-'))
  const path = join(dir, 'inbox.sqlite')
  let inbox = new FeishuInbox(path)
  try {
    const b = inbox.add('first', 'bot', profile)
    inbox.pair('first', b, event)
    const [bound] = inbox.bindings('first')
    inbox.accept(bound, {
      ...event,
      create_time: '1800000000100',
      message_id: 'om_next',
      event_id: 'next'
    })
    inbox.admitted(b.account, 'om_next')
    expect(() => inbox.queueReply(b.account, 'om_foreign', 'foreign', 'No')).toThrow(/FOREIGN KEY/)
    expect(inbox.queueReply(b.account, 'om_next', 'progress', 'Working')).toEqual({
      status: 'queued'
    })
    expect(inbox.mayPostReply(b.account, 'progress', 1000)).toBe(true)
    inbox.close()
    inbox = new FeishuInbox(path)
    expect(inbox.queueReply(b.account, 'om_next', 'progress', 'Working')).toEqual({
      status: 'queued'
    })
    expect(inbox.pendingReplies(b.account)).toEqual([
      { id: 'progress', mid: 'om_next', text: 'Working' }
    ])
    expect(() => inbox.queueReply(b.account, 'om_next', 'progress', 'Changed')).toThrow(
      /reply id was reused/
    )
    expect(inbox.mayPostReply(b.account, 'progress', 2000)).toBe(true)
    expect(inbox.mayPostReply(b.account, 'progress', 3_301_000)).toBe(false)
    expect(inbox.pendingReplies(b.account)).toEqual([])
    expect(inbox.needsReview(b.account)).toBe(true)
    expect(() => inbox.queueReply(b.account, 'om_next', 'progress', 'Working')).toThrow(
      /needs review/
    )
    expect(inbox.queueReply(b.account, 'om_next', 'answer', 'Done')).toEqual({ status: 'queued' })
    expect(inbox.mayPostReply(b.account, 'answer', 3_302_000)).toBe(true)
    inbox.replyPosted(b.account, 'answer', 'om_posted')
    inbox.close()
    inbox = new FeishuInbox(path)
    expect(inbox.queueReply(b.account, 'om_next', 'answer', 'Done')).toEqual({
      status: 'posted',
      messageId: 'om_posted'
    })
    expect(inbox.mayPostReply(b.account, 'answer', 3_303_000)).toBe(false)
    expect(inbox.pendingReplies(b.account)).toEqual([])
    inbox.remove('first', 'bot', b.account)
    expect(inbox.needsReview(b.account)).toBe(false)
    expect(() => inbox.queueReply(b.account, 'om_next', 'answer', 'Done')).toThrow(/FOREIGN KEY/)
  } finally {
    inbox.close()
    await rm(dir, { recursive: true, force: true })
  }
})
