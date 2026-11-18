import { describe, expect, it, vi } from 'vitest'
import { applyBotUpdates, BotUpdate } from '../../shared/rpc-contract/bots-params'
import { makeTestBot } from './bot.test-fixture'

describe('a Look around edit', () => {
  it('changes only the fields it names, so quick edits keep each other', () => {
    const bot = makeTestBot({ id: 'b1', agent: 'claude' })
    const first = applyBotUpdates(bot, { lookAround: { weekdaysOnly: false } })
    const second = applyBotUpdates(first, { lookAround: { focus: 'CI on main' } })
    expect(second.lookAround).toEqual({
      on: true,
      every: 'every-4h',
      weekdaysOnly: false,
      focus: 'CI on main'
    })
  })

  it('travels as just the changed field', () => {
    expect(
      BotUpdate.parse({ botId: 'b1', updates: { lookAround: { on: false } } }).updates
    ).toEqual({ lookAround: { on: false } })
  })

  it('stamps when Look around and Tidy-up are turned back on, and keeps it through other edits', () => {
    const off = makeTestBot({
      id: 'b1',
      agent: 'claude',
      lookAround: { on: false, every: 'every-4h', weekdaysOnly: true, focus: '' },
      tidyUp: { on: false }
    })
    vi.setSystemTime(new Date(2026, 10, 14, 14, 0))
    const on = applyBotUpdates(off, { lookAround: { on: true }, tidyUp: { on: true } })
    const stamped = new Date(2026, 10, 14, 14, 0).getTime()
    expect(on.lookAround?.since).toBe(stamped)
    expect(on.tidyUp?.since).toBe(stamped)
    vi.setSystemTime(new Date(2026, 10, 15, 9, 0))
    const edited = applyBotUpdates(on, {
      lookAround: { focus: 'CI on main', on: true },
      tidyUp: { every: 'week', on: true }
    })
    expect(edited.lookAround?.since).toBe(stamped)
    expect(edited.tidyUp?.since).toBe(stamped)
    vi.useRealTimers()
  })

  it('never takes a since from a client', () => {
    expect(
      BotUpdate.parse({ botId: 'b1', updates: { lookAround: { on: true, since: 1 } } }).updates
    ).toEqual({ lookAround: { on: true } })
  })
})
