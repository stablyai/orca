import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FeishuInbox } from './feishu-inbox'
import { cardData } from './feishu-card-data'

it('keeps one durable response per delivery, fences late events and deduplicates replayed progress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-response-'))
  const path = join(dir, 'db.sqlite')
  let store = new FeishuInbox(path)
  try {
    const b = store.add('scope', 'bot', { name: 'profile', appId: 'cli_app', brand: 'feishu' })
    const read = (id: string) => cardData.parse(JSON.parse(store.getCard(b.account, id)!.body))
    const id = store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', { kind: 'begin' })!
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', { kind: 'start', turn: 100 })
    store.postedCard(b.account, id, 2, 'om_response')
    const progress = { kind: 'progress' as const, id: 'reply-1', text: 'Checking the source' }
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', progress)
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', progress)
    store.updateResponse(b.account, 'lane', null, 'oc_chat', {
      kind: 'trace',
      turn: 100,
      text: 'Reading README'
    })
    store.close()
    store = new FeishuInbox(path)
    expect(read(id).response).toEqual({
      phase: 'working',
      turn: 100,
      progress: [{ id: 'reply-1', text: 'Checking the source' }],
      trace: ['Reading README']
    })
    const second = store.updateResponse(b.account, 'lane', 'om_two', 'oc_chat', { kind: 'begin' })!
    store.updateResponse(b.account, 'lane', 'om_two', 'oc_chat', { kind: 'start', turn: 200 })
    store.updateResponse(b.account, 'lane', null, 'oc_chat', {
      kind: 'trace',
      turn: 100,
      text: 'Running check'
    })
    expect(read(second).response?.trace).toEqual([])
    expect(read(id).response?.trace).toEqual(['Reading README', 'Running check'])
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'final',
      text: 'Verified'
    })
    const settled = store.getCard(b.account, id)!
    store.updateResponse(b.account, 'lane', null, 'oc_chat', {
      kind: 'trace',
      turn: 100,
      text: 'Stale work'
    })
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'status',
      text: 'Working'
    })
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', progress)
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'final',
      text: 'Wrong retry'
    })
    expect(store.getCard(b.account, id)).toEqual(settled)
    store.postedCard(b.account, id, 2, 'om_response')
    expect(store.pendingCards(b.account).find((c) => c.id === id)?.message).toBe('om_response')
    expect(store.updateResponse(b.account, 'other-lane', 'om_one', 'oc_chat', progress)).toBeNull()
    expect(store.updateResponse(b.account, 'lane', 'om_one', 'oc_other', progress)).toBeNull()
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
