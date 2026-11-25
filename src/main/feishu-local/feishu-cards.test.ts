import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FeishuInbox } from './feishu-inbox'
import { readFeishuClick } from './feishu-card-events'

it('persists one answer per card, rejects cross-chat and invalid options, and never reopens a settled prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-card-'))
  const path = join(dir, 'db.sqlite')
  let store = new FeishuInbox(path)
  try {
    const b = store.add('scope', 'bot', { name: 'profile', appId: 'cli_app', brand: 'feishu' })
    const data = {
      kind: 'prompt' as const,
      promptId: 'p1',
      text: 'Allow read?',
      options: [
        { id: 'yes', label: 'Allow' },
        { id: 'no', label: 'Deny' }
      ]
    }
    store.putCard(b.account, 'choices:once', 'lane', 'om_origin', 'oc_chat', {
      ...data,
      kind: 'choices'
    })
    expect(store.pendingChoice(b.account, 'om_origin')).toBe(true)
    store.postedCard(b.account, 'choices:once', 1, 'om_choices')
    expect(store.pendingChoice(b.account, 'om_origin')).toBe(false)
    store.putCard(b.account, 'p1', 'lane', 'om_origin', 'oc_chat', data)
    expect(store.sendingCard(b.account, 'p1', 1000)).toBe(true)
    store.postedCard(b.account, 'p1', 1, 'om_card')
    expect(store.claimCard(b.account, 'om_card', 'oc_other', 'yes')).toBeNull()
    expect(store.claimCard(b.account, 'om_card', 'oc_chat', 'invented')).toBeNull()
    expect(store.claimCard('other', 'om_card', 'oc_chat', 'yes')).toBeNull()
    expect(store.claimCard(b.account, 'om_card', 'oc_chat', 'yes')?.selected).toBe('yes')
    store.close()
    store = new FeishuInbox(path)
    expect(store.claimCard(b.account, 'om_card', 'oc_chat', 'no')).toBeNull()
    expect(store.pendingCards(b.account)[0]?.selected).toBe('yes')
    store.closeCard(b.account, 'p1', 'Answered')
    store.putCard(b.account, 'p1', 'lane', 'om_origin', 'oc_chat', data)
    expect(store.claimCard(b.account, 'om_card', 'oc_chat', 'yes')).toBeNull()
    store.postedCard(b.account, 'p1', 1, 'om_card')
    expect(store.pendingCards(b.account)[0]).toMatchObject({
      state: 'closed',
      revision: 2,
      sent: 1
    })
    store.putCard(b.account, 'p2', 'lane', 'om_origin', 'oc_chat', { ...data, promptId: 'p2' })
    store.closePrompts(b.account, 'lane', null, 'Moved on')
    expect(store.pendingCards(b.account).every((card) => card.state === 'closed')).toBe(true)
    store.putCard(b.account, 'new', 'lane', 'om_origin', 'oc_chat', {
      kind: 'status',
      text: 'Working',
      options: []
    })
    expect(store.sendingCard(b.account, 'new', 1000)).toBe(true)
    expect(store.sendingCard(b.account, 'new', 1000 + 55 * 60000)).toBe(false)
    expect(store.needsReview(b.account)).toBe(true)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('rejects forged callback shapes instead of accepting an unbound option', () => {
  const event = {
    type: 'card.action.trigger',
    operator_id: 'ou_owner',
    message_id: 'om_card',
    chat_id: 'oc_chat',
    host: 'im_message',
    action_tag: 'button',
    action_value: JSON.stringify({ orca: 'answer', option: 'yes' })
  }
  expect(readFeishuClick(JSON.stringify(event))?.option).toBe('yes')
  for (const bad of [
    { ...event, action_value: 'yes' },
    { ...event, message_id: '../../other' },
    { ...event, host: 'im_top_notice' },
    { ...event, action_tag: 'input' }
  ]) {
    expect(readFeishuClick(JSON.stringify(bad))).toBeNull()
  }
})
