import { describe, expect, it, vi } from 'vitest'
import { applyBotUpdates, BotUpdate } from '../../shared/rpc-contract/bots-params'
import { makeTestBot } from './bot.test-fixture'

describe('a Look around edit', () => {
  it('changes only the fields it names, so quick edits keep each other', () => {
    const bot = makeTestBot({ id: 'b1', agent: 'claude' })
    const edit = BotUpdate.parse({
      botId: 'b1',
      updates: { lookAround: { weekdaysOnly: false, since: 1 } }
    })
    expect(edit.updates).toEqual({ lookAround: { weekdaysOnly: false } })
    const first = applyBotUpdates(bot, edit.updates)
    const second = applyBotUpdates(first, { lookAround: { focus: 'CI on main' } })
    expect(second.lookAround).toEqual({
      on: true,
      every: 'every-4h',
      weekdaysOnly: false,
      focus: 'CI on main'
    })
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
})

describe('a Custom times edit', () => {
  const parse = (lookAround: Record<string, unknown>) =>
    BotUpdate.safeParse({ botId: 'b1', updates: { lookAround } })

  it('saves its times sorted, and a null zone goes back to the host clock', () => {
    const parsed = parse({ times: ['14:00', '09:30'], timezone: 'America/New_York' })
    expect(parsed.success && parsed.data.updates.lookAround).toEqual({
      times: ['09:30', '14:00'],
      timezone: 'America/New_York'
    })
    const bot = makeTestBot({ id: 'b1', agent: 'claude' })
    const custom = applyBotUpdates(bot, {
      lookAround: { times: ['09:30', '14:00'], timezone: 'America/New_York' }
    })
    expect(custom.lookAround).toMatchObject({ every: 'custom', timezone: 'America/New_York' })
    expect(applyBotUpdates(custom, { lookAround: { timezone: null } }).lookAround?.timezone).toBe(
      'host'
    )
  })

  it('refuses times under an hour apart, counting past midnight, and repeats', () => {
    expect(parse({ times: ['09:30', '10:00'] }).success).toBe(false)
    expect(parse({ times: ['23:30', '00:15'] }).success).toBe(false)
    expect(parse({ times: ['09:00', '09:00'] }).success).toBe(false)
    expect(parse({ times: ['9:00'] }).success).toBe(false)
    expect(parse({ times: [] }).success).toBe(false)
    expect(parse({ times: ['23:00', '00:00'] }).success).toBe(true)
  })

  it('refuses more than 12 a day and an unknown zone', () => {
    const thirteen = Array.from(
      { length: 13 },
      (_, hour) => `${String(hour + 8).padStart(2, '0')}:00`
    )
    expect(parse({ times: thirteen }).success).toBe(false)
    expect(parse({ times: thirteen.slice(0, 12) }).success).toBe(true)
    expect(parse({ timezone: 'Mars/Olympus' }).success).toBe(false)
  })

  it('refuses Custom with no times, and still takes unrelated edits on such a saved record', () => {
    const bot = makeTestBot({ id: 'b1', agent: 'claude' })
    expect(() => applyBotUpdates(bot, { lookAround: { every: 'custom' } })).toThrow(/needs times/)
    const corrupt = makeTestBot({
      id: 'b1',
      agent: 'claude',
      lookAround: { on: false, every: 'custom', weekdaysOnly: true, focus: '' }
    })
    expect(applyBotUpdates(corrupt, { lookAround: { focus: 'CI' } }).lookAround?.focus).toBe('CI')
    expect(() => applyBotUpdates(corrupt, { lookAround: { on: true } })).toThrow(/needs times/)
  })

  it('keeps Custom times and zone through an older client’s field edits', () => {
    const custom = makeTestBot({
      id: 'b1',
      agent: 'claude',
      lookAround: {
        on: true,
        every: 'custom',
        weekdaysOnly: true,
        focus: '',
        times: ['09:30'],
        timezone: 'Asia/Tokyo'
      }
    })
    const edited = applyBotUpdates(applyBotUpdates(custom, { lookAround: { on: false } }), {
      lookAround: { focus: 'PRs', weekdaysOnly: false }
    })
    expect(edited.lookAround).toEqual({
      on: false,
      every: 'custom',
      weekdaysOnly: false,
      focus: 'PRs',
      times: ['09:30'],
      timezone: 'Asia/Tokyo'
    })
  })
})

describe('the first schedule edit’s zone', () => {
  const bot = makeTestBot({ id: 'b1', agent: 'claude' })
  const edit = (lookAround: Parameters<typeof applyBotUpdates>[1]['lookAround'], on = bot) =>
    applyBotUpdates(on, { lookAround }, 'America/Los_Angeles').lookAround

  it('is saved when the editor is in the host’s zone, and only when none is saved', () => {
    expect(edit({ every: 'every-2h', editorTimeZone: 'America/Los_Angeles' })?.timezone).toBe(
      'America/Los_Angeles'
    )
    const set = applyBotUpdates(bot, { lookAround: { timezone: 'Asia/Tokyo' } })
    expect(edit({ times: ['09:00'], editorTimeZone: 'America/Los_Angeles' }, set)?.timezone).toBe(
      'Asia/Tokyo'
    )
  })

  it('is not saved for an editor elsewhere, a non-schedule edit, or beside an explicit clear', () => {
    expect(edit({ every: 'every-2h', editorTimeZone: 'America/New_York' })).not.toHaveProperty(
      'timezone'
    )
    expect(edit({ focus: 'x', editorTimeZone: 'America/Los_Angeles' })).not.toHaveProperty(
      'timezone'
    )
    expect(
      edit({ times: ['09:00'], timezone: null, editorTimeZone: 'America/Los_Angeles' })?.timezone
    ).toBe('host')
  })
})

describe('zones and dormant values', () => {
  const bot = makeTestBot({ id: 'b1', agent: 'claude' })
  const parse = (timezone: unknown) =>
    BotUpdate.safeParse({ botId: 'b1', updates: { lookAround: { timezone } } })

  it('takes only IANA names and UTC, never abbreviations, offsets or the wrong case', () => {
    for (const zone of ['PST', 'EST', '+01:00', 'america/los_angeles', 'PST8PDT', 'GMT+5']) {
      expect(parse(zone).success).toBe(false)
    }
    for (const zone of ['America/New_York', 'UTC', 'Australia/Lord_Howe']) {
      expect(parse(zone).success).toBe(true)
    }
  })

  it('keeps "follow the host clock" through a later edit from the host’s own zone', () => {
    const host = applyBotUpdates(bot, { lookAround: { timezone: null } }, 'America/Los_Angeles')
    expect(host.lookAround?.timezone).toBe('host')
    const edited = applyBotUpdates(
      host,
      { lookAround: { every: 'every-2h', editorTimeZone: 'America/Los_Angeles' } },
      'America/Los_Angeles'
    )
    expect(edited.lookAround?.timezone).toBe('host')
  })

  it('lets a preset bot with unusable kept times turn on, switch preset and change days', () => {
    const dormant = makeTestBot({
      id: 'b1',
      agent: 'claude',
      lookAround: {
        on: false,
        every: 'every-4h',
        weekdaysOnly: true,
        focus: '',
        times: ['09:00', '09:30']
      }
    })
    expect(applyBotUpdates(dormant, { lookAround: { on: true } }).lookAround?.on).toBe(true)
    expect(applyBotUpdates(dormant, { lookAround: { every: 'every-2h' } }).lookAround?.every).toBe(
      'every-2h'
    )
    expect(
      applyBotUpdates(dormant, { lookAround: { weekdaysOnly: false } }).lookAround?.weekdaysOnly
    ).toBe(false)
    expect(() => applyBotUpdates(dormant, { lookAround: { every: 'custom' } })).toThrow()
  })
})
