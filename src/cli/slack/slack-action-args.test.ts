import { describe, expect, it } from 'vitest'
import { actionArgs, scheduledFor } from './slack-action-args'

// 2026-11-20T12:00:00Z
const NOW = 1_795_176_000_000
const NOW_S = NOW / 1000

describe('scheduledFor', () => {
  it('reads a while from now, and a time with its zone, as one moment', () => {
    expect(scheduledFor(undefined, NOW)).toEqual({})
    expect(scheduledFor('+30m', NOW)).toEqual({ postAt: NOW_S + 1_800 })
    expect(scheduledFor(' +2h ', NOW)).toEqual({ postAt: NOW_S + 7_200 })
    expect(scheduledFor('+3d', NOW)).toEqual({ postAt: NOW_S + 259_200 })
    expect(scheduledFor('2026-11-21T09:00:00-08:00', NOW)).toEqual({ postAt: 1_795_280_400 })
    expect(scheduledFor('2026-11-21T17:00Z', NOW)).toEqual({ postAt: 1_795_280_400 })
  })

  it('refuses a time with no zone, one already past, and one past what Slack schedules', () => {
    const refusal = (at: string): string => {
      try {
        scheduledFor(at, NOW)
        return 'taken'
      } catch (error) {
        return error instanceof Error ? error.message : 'unknown'
      }
    }
    const shape =
      '--at takes a while from now (+30m, +2h, +3d) or a time with its zone (2026-12-01T09:00:00-08:00).'
    expect(refusal('tomorrow 9am')).toBe(shape)
    expect(refusal('2026-11-21T09:00:00')).toBe(shape)
    // A blank, and a day the month doesn't have, are mistakes, not a post for now or for another day.
    expect(refusal('')).toBe(shape)
    expect(refusal('2026-11-31T17:00:00Z')).toBe(shape)
    expect(refusal('2027-02-29T09:00:00Z')).toBe(shape)
    expect(refusal('+0m')).toBe(
      '--at must be at least a minute from now. Leave it out to post now.'
    )
    expect(refusal('2026-11-20T11:00:00Z')).toBe(
      '--at must be at least a minute from now. Leave it out to post now.'
    )
    expect(refusal('+121d')).toBe('Slack schedules a post at most 120 days ahead.')
  })
})

describe('actionArgs for Slack’s own surfaces', () => {
  const flags = (entries: Record<string, string | boolean>) => new Map(Object.entries(entries))

  it('reads a pin, a canvas, a list and a look at scheduled posts from their flags', async () => {
    expect(await actionArgs('pin', flags({}), '/')).toEqual({})
    expect(await actionArgs('pin', flags({ remove: true }), '/')).toEqual({ remove: true })
    expect(
      await actionArgs('canvas', flags({ title: 'Release plan', text: '# Plan\n- ship' }), '/')
    ).toEqual({ title: 'Release plan', text: '# Plan\n- ship' })
    expect(await actionArgs('scheduled', flags({}), '/')).toEqual({})
    expect(await actionArgs('scheduled', flags({ cancel: 'Q123' }), '/')).toEqual({
      cancel: 'Q123'
    })
  })

  it('refuses a blank --cancel, which would otherwise list', async () => {
    await expect(actionArgs('scheduled', flags({ cancel: '' }), '/')).rejects.toThrow(
      '--cancel takes the id `orca slack scheduled <place>` lists.'
    )
  })

  it('refuses a list with no item', async () => {
    await expect(actionArgs('list', flags({ title: 'Launch' }), '/')).rejects.toThrow(
      'A list needs at least one --item.'
    )
  })
})
