import { describe, expect, it } from 'vitest'
import { createHarness } from './harness'
import { USAGE_HISTORY_DAYS, usageHistoryStart } from '../src/usage-history'

const HOUR = 3600
const DAY_MS = 24 * 3600 * 1000
// Tokens are checked against the real clock, so the fixture's "now" is real too.
const NOW = Date.now()
const utcMidnight = Math.floor(NOW / DAY_MS) * DAY_MS
// Today's segment, kept inside today even just after midnight.
const END = Math.max(utcMidnight, NOW - 60_000)

async function seeded() {
  const h = await createHarness()
  h.setNow(NOW)
  const insert = h.raw.prepare(
    `INSERT INTO usage_events (usage_id, account_id, sandbox_id, machine_size, started_at, ended_at, weighted_seconds,
       period_start, overage_seconds, created_at, user_id) VALUES (?, ?, ?, 'standard', ?, ?, ?, NULL, 0, ?, ?)`
  )
  let n = 0
  const add = (endedAt: number, hours: number, sandboxId: string, userId: string | null, account = 'org:o1') => {
    insert.run(`u${n++}`, account, sandboxId, endedAt - 60_000, endedAt, hours * HOUR, endedAt, userId)
  }
  add(END, 2, 'sbx_a', 'alice')
  add(END - DAY_MS, 1, 'sbx_b', 'bob')
  add(END - 3 * DAY_MS, 3, 'sbx_a', 'alice')
  // Six more members, half an hour each: three make the top five, three don't.
  for (const user of ['c', 'd', 'e', 'f', 'g', 'h']) {
    add(END - 5 * DAY_MS, 0.5, `sbx_${user}`, user)
  }
  // A segment from before members were recorded.
  add(END - 6 * DAY_MS, 0.25, 'sbx_old', null)
  // Outside the 30 days, and another team's: never counted.
  add(NOW - 31 * DAY_MS, 9, 'sbx_a', 'alice')
  add(NOW - DAY_MS, 9, 'sbx_z', 'zed', 'org:o2')
  return h
}

async function read(h: Awaited<ReturnType<typeof seeded>>, role: string, sub = 'alice', query = '') {
  const token = await h.desktopToken({ sub, org: 'o1', orgRole: role })
  return h.call('GET', `/v1/billing/usage${query}`, { headers: { authorization: `Bearer ${token}` } })
}

describe('GET /v1/billing/usage', () => {
  it('returns 30 local days of team hours and the owner/admin breakdown', async () => {
    const h = await seeded()
    const { status, body } = await read(h, 'owner')
    expect(status).toBe(200)
    expect(body.days).toHaveLength(USAGE_HISTORY_DAYS)
    expect(body.days.at(-1)).toEqual({ start: utcMidnight, seconds: 2 * HOUR })
    expect(body.days.at(-2).seconds).toBe(1 * HOUR)
    expect(body.days.at(-4).seconds).toBe(3 * HOUR)
    expect(body.totalSeconds).toBe(9.25 * HOUR)
    expect(body.yourSeconds).toBe(5 * HOUR)
    expect(body.members.top.map((m: { userId: string }) => m.userId).slice(0, 2)).toEqual(['alice', 'bob'])
    // Up to USAGE_HISTORY_TOP (20) named rows, so all 8 members fit; the desktop shows 5 (V3-06).
    expect(body.members.top).toHaveLength(8)
    expect(body.members.otherCount).toBe(0)
    // Only the unattributed quarter hour is left over.
    expect(body.members.otherSeconds).toBe(0.25 * HOUR)
    expect(body.sandboxes.top[0]).toEqual({ sandboxId: 'sbx_a', seconds: 5 * HOUR })
  })

  it('gives members the team chart and their own hours, never the breakdown', async () => {
    const h = await seeded()
    const { body } = await read(h, 'member', 'bob')
    expect(body.totalSeconds).toBe(9.25 * HOUR)
    expect(body.yourSeconds).toBe(1 * HOUR)
    expect(body.members).toBeNull()
    expect(body.sandboxes).toBeNull()
  })

  it('starts days at the viewer’s local midnight', async () => {
    const h = await seeded()
    const { body } = await read(h, 'admin', 'alice', '?utcOffset=-480')
    // In UTC-8 a day starts at 08:00 UTC.
    const today = body.days.at(-1).start
    expect(new Date(today).getUTCHours()).toBe(8)
    expect(today).toBeLessThanOrEqual(NOW)
    expect(NOW - today).toBeLessThan(DAY_MS)
    expect(body.days[0].start).toBe(usageHistoryStart(NOW, -480))
  })

  it('rejects a bad offset and an unsigned caller', async () => {
    const h = await seeded()
    expect((await read(h, 'owner', 'alice', '?utcOffset=9999')).status).toBe(400)
    expect((await h.call('GET', '/v1/billing/usage')).status).toBe(401)
  })

  it('returns zeroed days for a team with no usage', async () => {
    const h = await createHarness()
    h.setNow(NOW)
    const token = await h.desktopToken({ sub: 'u1', org: 'o9', orgRole: 'owner' })
    const { body } = await h.call('GET', '/v1/billing/usage', { headers: { authorization: `Bearer ${token}` } })
    expect(body.totalSeconds).toBe(0)
    expect(body.days.every((day: { seconds: number }) => day.seconds === 0)).toBe(true)
    expect(body.members).toEqual({ top: [], otherCount: 0, otherSeconds: 0 })
  })
})
