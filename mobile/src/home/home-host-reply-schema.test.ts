import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { totalHomeStats } from '../stats/home-stats-total'
import { homeHostAccountsSchema, homeHostStatsSchema } from './home-host-reply-schema'

function reads<T>(schema: z.ZodType<T, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`expected a readable reply: ${parsed.error.message}`)
  }
  return parsed.data
}

function readsRow(value: unknown): NonNullable<z.output<typeof homeHostStatsSchema>> {
  const row = reads(homeHostStatsSchema, value)
  if (!row) {
    throw new Error('expected an object row')
  }
  return row
}

function refuses(schema: z.ZodType<unknown, unknown>, value: unknown): boolean {
  return !schema.safeParse(value).success
}

describe('a stats row is checked as an object and nothing more', () => {
  it('reads the row a current host sends', () => {
    const row = {
      totalAgentsSpawned: 3,
      totalPRsCreated: 1,
      totalAgentTimeMs: 90,
      firstEventAt: 1700000000000
    }
    expect(readsRow(row)).toMatchObject(row)
  })

  it('reads a host that answers a shape totalHomeStats still sums', () => {
    expect(readsRow({ totalWorktrees: 3 })).toMatchObject({ totalWorktrees: 3 })
    expect(readsRow({}).totalAgentsSpawned).toBe(undefined)
  })

  it('preserves an explicit null firstEventAt, which the total reads as no events yet', () => {
    expect(readsRow({ firstEventAt: null }).firstEventAt).toBe(null)
    expect(readsRow({ firstEventAt: 'never' }).firstEventAt).toBe(undefined)
  })

  // Main seated a null or absent summary in the per-host slot and `totalHomeStats` skipped it, so
  // the header still drew a zeroed row. Refusing here would empty the row instead of zeroing it.
  // The row reaches `totalHomeStats` through `fetchMobileHomeStats`'s `.catch(() => {})`, so a
  // refusal is silent: the per-host slot is never written and `hostIds.filter` drops the host
  // entirely, which turns main's zeroed header row into no row at all.
  it('seats a non-object summary in the slot rather than refusing the host out of the total', () => {
    for (const value of ['garbage', 7, true, []]) {
      expect(refuses(homeHostStatsSchema, value)).toBe(false)
      expect(reads(homeHostStatsSchema, value)).toBe(undefined)
    }
    expect(totalHomeStats({ 'host-1': reads(homeHostStatsSchema, 'garbage') }, ['host-1'])).toEqual(
      {
        totalAgentsSpawned: 0,
        totalPRsCreated: 0,
        totalAgentTimeMs: 0,
        firstEventAt: null
      }
    )
  })

  it('seats a null or absent summary in the card slot, which the total skips', () => {
    expect(refuses(homeHostStatsSchema, null)).toBe(false)
    expect(refuses(homeHostStatsSchema, undefined)).toBe(false)
    expect(reads(homeHostStatsSchema, null)).toBe(null)
    expect(totalHomeStats({ 'host-1': reads(homeHostStatsSchema, null) }, ['host-1'])).toEqual({
      totalAgentsSpawned: 0,
      totalPRsCreated: 0,
      totalAgentTimeMs: 0,
      firstEventAt: null
    })
  })
})

describe('the accounts snapshot stays opaque', () => {
  it('takes every shape decodeAccountsSnapshot judges', () => {
    expect(refuses(homeHostAccountsSchema, null)).toBe(false)
    expect(refuses(homeHostAccountsSchema, { claude: { accounts: [] } })).toBe(false)
  })
})
