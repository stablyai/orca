import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FeishuInbox } from './feishu-inbox'
import { cardData } from './feishu-card-data'

it('persists the current question across finalization, restart, and stale question updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-question-'))
  const path = join(dir, 'db.sqlite')
  let store = new FeishuInbox(path)
  try {
    const b = store.add('scope', 'bot', { name: 'p', appId: 'cli_app', brand: 'feishu' })
    const response = () =>
      cardData.parse(JSON.parse(store.getCard(b.account, 'response:om_one')!.body)).response!
    const put = (id: string, external = 'lane') =>
      store.putCard(b.account, id, external, 'om_one', 'oc_chat', {
        kind: 'async-question',
        promptId: id,
        text: 'Choose',
        options: [{ id: '0', label: 'Yes' }]
      })
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', { kind: 'begin' })
    put('q1')
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'final',
      text: 'Question sent'
    })
    expect(response().question).toEqual({ id: 'q1', pending: true })
    store.close()
    store = new FeishuInbox(path)
    expect(response().question).toEqual({ id: 'q1', pending: true })
    store.postedCard(b.account, 'q1', 1, 'om_card1')
    expect(store.claimCard(b.account, 'om_card1', 'oc_other', '0')).toBeNull()
    expect(response().question?.pending).toBe(true)
    expect(store.claimCard(b.account, 'om_card1', 'oc_chat', '0')?.state).toBe('claimed')
    expect(response().question).toEqual({ id: 'q1', pending: false })
    put('q1')
    expect(response().question?.pending).toBe(false)
    put('q2')
    store.closeCard(b.account, 'q1', 'Selected')
    put('q1')
    put('foreign', 'other-lane')
    expect(response().question).toEqual({ id: 'q2', pending: true })
    expect(response().final).toBe('Question sent')
    store.closePrompts(b.account, 'lane', null, 'Ended', 'async-question')
    expect(response().question).toEqual({ id: 'q2', pending: false })
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
