import { describe, expect, it } from 'vitest'
import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import { botActiveWorkSection } from './bot-active-work'

describe('an In progress item nothing runs for', () => {
  it('gets a note until a worker or a wait is linked, said again only when its state changes', () => {
    const idle = makeTestBotItem(7)
    const waited = makeTestBotItem(8, {
      links: [{ kind: 'automation', ref: 'a1', name: 'CI on #9', active: true }]
    })
    const first = botActiveWorkSection([idle, waited], [])
    expect(first.text).toContain('Item 7 is In progress but nothing is running for it')
    expect(first.text).not.toContain('Item 8 is')
    expect(botActiveWorkSection([idle, waited], []).key).toBe(first.key)
    const started = makeTestBotItem(7, {
      links: [
        {
          kind: 'dispatch',
          ref: 'ctx_1',
          latest: null,
          title: 'Fix it',
          state: 'working',
          host: null,
          startedAt: 0,
          settledAt: null,
          report: null,
          pr: null
        }
      ]
    })
    const next = botActiveWorkSection([started, waited], [])
    expect(next.text).not.toContain('nothing is running')
    expect(next.key).not.toBe(first.key)
  })
})
