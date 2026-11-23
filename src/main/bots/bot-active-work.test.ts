import { describe, expect, it } from 'vitest'
import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import type { BotItemLinkView } from '../../shared/bots/bot-items'
import { botActiveWorkSection, botIdleItemsNote } from './bot-active-work'

const worker = (state: 'working' | 'unknown' | 'completed'): BotItemLinkView => ({
  kind: 'dispatch',
  ref: `ctx_${state}`,
  latest: null,
  title: 'Fix it',
  state,
  host: null,
  startedAt: 0,
  settledAt: null,
  report: null,
  pr: null
})

describe('an In progress item nothing runs for', () => {
  it('is idle with no live worker and no active wait, and not with either', () => {
    const items = [
      makeTestBotItem(1),
      makeTestBotItem(2, { links: [worker('completed')] }),
      makeTestBotItem(3, {
        links: [{ kind: 'automation', ref: 'a1', name: 'CI', active: false }]
      }),
      makeTestBotItem(4, { links: [worker('unknown')] }),
      makeTestBotItem(5, { links: [{ kind: 'automation', ref: 'a2', name: 'CI', active: true }] })
    ]
    const section = botActiveWorkSection(items, [])
    expect(section.idle?.map((item) => item.number)).toEqual([1, 2, 3])
    expect(section.text).not.toContain('nothing is running')
  })

  it('is noted once per chat, again only when that item changes, whatever else changes', () => {
    const memo = new Map<string, Map<number, string>>()
    const say = (sessionId: string, idle: readonly { number: number; key: string }[]) => {
      const note = botIdleItemsNote(memo, sessionId, idle)
      note?.given()
      return note?.text ?? null
    }
    const idle7 = { number: 7, key: 'e10' }
    expect(say('chat', [idle7])).toContain('Item 7 is In progress')
    expect(say('chat', [idle7])).toBeNull()
    const other = botActiveWorkSection([makeTestBotItem(7), makeTestBotItem(8)], [])
    expect(other.idle).toEqual([
      { number: 7, key: 'e10' },
      { number: 8, key: 'e10' }
    ])
    expect(say('chat', other.idle!)).toMatch(/^\[Orca: Item 8 /)
    expect(say('chat', [{ number: 7, key: 'e11' }])).toContain('Item 7')
    expect(say('other-chat', [idle7])).toContain('Item 7')
  })

  it('is said again when the turn that had it never delivered it', () => {
    const memo = new Map<string, Map<number, string>>()
    const idle7 = [{ number: 7, key: 'e10' }]
    expect(botIdleItemsNote(memo, 'chat', idle7)?.text).toContain('Item 7')
    expect(botIdleItemsNote(memo, 'chat', idle7)?.text).toContain('Item 7')
  })
})
