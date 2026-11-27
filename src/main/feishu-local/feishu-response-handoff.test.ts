import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FeishuInbox } from './feishu-inbox'
import { cardData, type FeishuResponseChange } from './feishu-card-data'

it('moves a running answer forward across repeated steers and restart while freezing older cards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-handoff-'))
  const path = join(dir, 'db.sqlite')
  let store = new FeishuInbox(path)
  try {
    const b = store.add('scope', 'bot', { name: 'profile', appId: 'cli_app', brand: 'feishu' })
    const change = (original: string, value: FeishuResponseChange) =>
      store.updateResponse(b.account, 'lane', original, 'oc_chat', value)
    const card = (original: string) => store.getCard(b.account, `response:${original}`)!
    const response = (original: string) => cardData.parse(JSON.parse(card(original).body)).response!
    const native = {
      turnItemId: 'turn-1',
      startedAt: 100,
      tools: [],
      messages: [{ id: 'm1', text: 'First progress' }]
    }
    change('om_one', { kind: 'begin' })
    change('om_one', { kind: 'start', turn: 100 })
    change('om_one', { kind: 'native', value: native })
    change('om_two', { kind: 'begin' })
    change('om_two', { kind: 'handoff', from: 'om_one', turnItemId: 'turn-1', at: 200 })
    const first = card('om_one')
    expect(response('om_one').supersededBy).toBe('response:om_two')
    expect(response('om_two').baseline).toEqual(native)
    expect(change('om_one', { kind: 'progress', id: 'p2', text: 'Second progress' })).toBe(
      'response:om_two'
    )
    change('om_one', {
      kind: 'native',
      value: { ...native, messages: [...native.messages, { id: 'm2', text: 'Second text' }] }
    })
    change('om_three', { kind: 'begin' })
    change('om_three', { kind: 'handoff', from: 'om_one', turnItemId: 'turn-1', at: 300 })
    const second = card('om_two')
    expect(response('om_two').supersededBy).toBe('response:om_three')
    expect(response('om_three').baseline?.messages).toEqual([
      { id: 'm1', text: 'First progress' },
      { id: 'm2', text: 'Second text' }
    ])
    store.close()
    store = new FeishuInbox(path)
    change('om_two', { kind: 'handoff', from: 'om_one', turnItemId: 'turn-1', at: 400 })
    change('om_one', { kind: 'status', text: 'Running' })
    change('om_one', {
      kind: 'native',
      value: { ...native, completedAt: 500, messages: [{ id: 'm3', text: 'Complete answer' }] }
    })
    expect(change('om_one', { kind: 'final', text: 'Complete answer' })).toBe('response:om_three')
    expect(response('om_three').final).toBe('Complete answer')
    expect(response('om_three').progress).toEqual([])
    expect(card('om_one')).toEqual(first)
    expect(card('om_two')).toEqual(second)
    const last = card('om_three')
    change('om_four', { kind: 'begin' })
    change('om_four', { kind: 'handoff', from: 'om_one', turnItemId: 'turn-1', at: 600 })
    expect(card('om_three')).toEqual(last)
    expect(response('om_four').baseline).toBeUndefined()
    expect(response('om_four').final).toBeUndefined()
    change('om_one', { kind: 'final', text: 'Stale retry' })
    expect(card('om_three')).toEqual(last)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('refuses handoffs across accounts, chats, lanes and native turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-handoff-fence-'))
  const store = new FeishuInbox(join(dir, 'db.sqlite'))
  try {
    const b = store.add('scope', 'bot', { name: 'p', appId: 'cli_app', brand: 'feishu' })
    const other = store.add('scope', 'other', { name: 'q', appId: 'cli_other', brand: 'feishu' })
    store.updateResponse(b.account, 'lane', 'om_one', 'oc_chat', {
      kind: 'native',
      value: { turnItemId: 'turn-1', startedAt: 100, messages: [], tools: [] }
    })
    const source = store.getCard(b.account, 'response:om_one')
    for (const [account, lane, chat, turnItemId] of [
      [other.account, 'lane', 'oc_chat', 'turn-1'],
      [b.account, 'other-lane', 'oc_chat', 'turn-1'],
      [b.account, 'lane', 'oc_other', 'turn-1'],
      [b.account, 'lane', 'oc_chat', 'turn-2']
    ]) {
      store.updateResponse(account, lane, `om_${turnItemId}_${chat}_${lane}`, chat, {
        kind: 'begin'
      })
      store.updateResponse(account, lane, `om_${turnItemId}_${chat}_${lane}`, chat, {
        kind: 'handoff',
        from: 'om_one',
        turnItemId,
        at: 200
      })
      expect(store.getCard(b.account, 'response:om_one')).toEqual(source)
    }
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
