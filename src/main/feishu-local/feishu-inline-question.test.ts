import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FeishuInbox } from './feishu-inbox'
import { cardData, type FeishuResponseChange } from './feishu-card-data'

it('keeps button continuations on one persisted card, rejects stale clicks, and still hands off real prompts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-inline-'))
  const path = join(dir, 'db.sqlite')
  let store = new FeishuInbox(path)
  try {
    const b = store.add('scope', 'bot', { name: 'p', appId: 'cli_app', brand: 'feishu' })
    const change = (mid: string, c: FeishuResponseChange) =>
      store.updateResponse(b.account, 'lane', mid, 'oc_chat', c)
    const response = () =>
      cardData.parse(JSON.parse(store.getCard(b.account, 'response:om_one')!.body)).response!
    const ask = (id: string, mid: string) =>
      store.putCard(b.account, id, 'lane', mid, 'oc_chat', {
        kind: 'async-question',
        inline: true,
        promptId: id,
        text: 'Choose',
        options: [{ id: '0', label: 'Yes' }]
      })
    change('om_one', { kind: 'begin' })
    change('om_one', {
      kind: 'native',
      value: {
        turnItemId: 't1',
        startedAt: 1,
        completedAt: 2,
        deliveries: ['om_one'],
        messages: [{ id: 'm1', text: 'Before choice' }],
        tools: []
      }
    })
    change('om_one', { kind: 'final', text: 'Question sent' })
    store.postedCard(b.account, 'response:om_one', 3, 'om_physical')
    ask('q1', 'om_one')
    expect(store.claimCard(b.account, 'om_physical', 'oc_chat', '0', 'wrong')).toBeNull()
    expect(store.claimCard(b.account, 'om_physical', 'oc_other', '0', 'q1')).toBeNull()
    expect(store.claimCard(b.account, 'om_physical', 'oc_chat', '0', 'q1')?.id).toBe('q1')
    expect(store.claimCard(b.account, 'om_physical', 'oc_chat', '0', 'q1')).toBeNull()
    const next = store.questionContinuation(b.account, 'q1')!
    expect(next.message).toBe('om_physical')
    store.close()
    store = new FeishuInbox(path)
    expect(store.questionContinuation(b.account, 'q1')).toEqual(next)
    store.closeCard(b.account, 'q1', '已选择：Yes')
    expect(change(next.mid, { kind: 'begin' })).toBe('response:om_one')
    expect(store.getCard(b.account, `response:${next.mid}`)).toBeNull()
    change('om_one', { kind: 'final', text: 'Late old final' })
    expect(response().final).toBeUndefined()
    change(next.mid, {
      kind: 'native',
      value: {
        turnItemId: 't2',
        startedAt: 3,
        deliveries: [next.mid],
        messages: [{ id: 'm2', text: 'After choice' }],
        tools: []
      }
    })
    expect(response().history?.[0].messages).toEqual([
      { id: 'm1', text: 'Before choice' },
      { id: 'previous-final', text: 'Question sent' }
    ])
    ask('q2', next.mid)
    expect(store.questionResponse(b.account, 'q2')?.message).toBe('om_physical')
    expect(store.claimCard(b.account, 'om_physical', 'oc_chat', '0', 'q1')).toBeNull()
    change('om_new_prompt', { kind: 'begin' })
    change('om_new_prompt', { kind: 'handoff', from: next.mid, turnItemId: 't2', at: 4 })
    expect(response().supersededBy).toBe('response:om_new_prompt')
    expect(store.claimCard(b.account, 'om_physical', 'oc_chat', '0', 'q2')).toBeNull()
    const frozen = store.getCard(b.account, 'response:om_one')
    change(next.mid, { kind: 'final', text: 'Complete answer' })
    expect(store.getCard(b.account, 'response:om_one')).toEqual(frozen)
    expect(
      cardData.parse(JSON.parse(store.getCard(b.account, 'response:om_new_prompt')!.body)).response
        ?.final
    ).toBe('Complete answer')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
