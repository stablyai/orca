import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FeishuInbox } from './feishu-inbox'
import { cardData } from './feishu-card-data'

it('keeps native worker activity across final replies and restart until workers settle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-workers-'))
  const path = join(dir, 'db.sqlite')
  let store = new FeishuInbox(path)
  try {
    const b = store.add('scope', 'bot', { name: 'profile', appId: 'cli_app', brand: 'feishu' })
    const update = (change: Parameters<FeishuInbox['updateResponse']>[4]) =>
      store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', change)
    const id = update({ kind: 'begin' })!
    update({ kind: 'workers', running: true })
    update({ kind: 'final', text: 'Waiting for the worker' })
    store.close()
    store = new FeishuInbox(path)
    const read = () => cardData.parse(JSON.parse(store.getCard(b.account, id)!.body)).response
    expect(read()).toMatchObject({
      phase: 'working',
      workersRunning: true,
      final: 'Waiting for the worker'
    })
    update({ kind: 'status', text: '已完成' })
    expect(read()?.phase).toBe('working')
    update({ kind: 'workers', running: false })
    expect(read()).toMatchObject({
      phase: 'done',
      workersRunning: false,
      final: 'Waiting for the worker'
    })
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('keeps one durable response per delivery, fences late events and deduplicates replayed progress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-response-'))
  const path = join(dir, 'db.sqlite')
  let store = new FeishuInbox(path)
  try {
    const b = store.add('scope', 'bot', { name: 'profile', appId: 'cli_app', brand: 'feishu' })
    const read = (id: string) => cardData.parse(JSON.parse(store.getCard(b.account, id)!.body))
    const id = store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', { kind: 'begin' })!
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', { kind: 'start', turn: 100 })
    store.cardkit(b.account, id, '12345')
    expect(store.cardSequence(b.account, id)).toBe(1)
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
    expect(store.cardSequence(b.account, id)).toBe(2)
    expect(store.getCard(b.account, id)?.cardkit).toBe('12345')
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

it('merges bounded native snapshots across restart without reopening completed turns or mixing turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-native-response-'))
  const path = join(dir, 'db.sqlite')
  let store = new FeishuInbox(path)
  try {
    const b = store.add('scope', 'bot', { name: 'profile', appId: 'cli_app', brand: 'feishu' })
    const value = {
      turnItemId: 'turn-1',
      startedAt: 100,
      messages: [{ id: 'm1', text: 'First' }],
      tools: []
    }
    const id = store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'native',
      value
    })!
    store.close()
    store = new FeishuInbox(path)
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'native',
      value: { ...value, messages: [{ id: 'm2', text: 'Second' }] }
    })
    const read = () => cardData.parse(JSON.parse(store.getCard(b.account, id)!.body)).response!
    expect(read().native?.messages).toEqual([
      { id: 'm1', text: 'First' },
      { id: 'm2', text: 'Second' }
    ])
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'native',
      value: { ...value, turnItemId: 'turn-2', startedAt: 200, messages: [] }
    })
    expect(read().native?.messages).toEqual([])
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'native',
      value: { ...value, turnItemId: 'turn-2', startedAt: 200, completedAt: 300, messages: [] }
    })
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'final',
      text: 'Finished'
    })
    const settled = store.getCard(b.account, id)
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'native',
      value: { ...value, turnItemId: 'turn-2', startedAt: 200 }
    })
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'native',
      value: { ...value, turnItemId: 'turn-3', startedAt: 400 }
    })
    expect(store.getCard(b.account, id)).toEqual(settled)
    expect(read().final).toBe('Finished')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
