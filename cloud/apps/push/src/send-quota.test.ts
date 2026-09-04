import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openInMemoryPushDatabase, type PushDatabase } from './push-database.js'
import { PushSendQuota } from './send-quota.js'

const HOST = 'abcdefghijklmnop'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

describe('push send quota', () => {
  let database: PushDatabase
  let clock = 1_700_000_000_000
  let quota: PushSendQuota

  beforeEach(async () => {
    database = await openInMemoryPushDatabase()
    clock = 1_700_000_000_000
    quota = new PushSendQuota(database, () => clock)
  })

  afterEach(async () => {
    await database.close()
  })

  async function reserveMany(count: number, registrationId: string): Promise<string[]> {
    const decisions: string[] = []
    for (let index = 0; index < count; index++) {
      decisions.push(await quota.reserve(HOST, registrationId))
    }
    return decisions
  }

  it('admits exactly the hourly host allowance and refuses the next send', async () => {
    const decisions = await reserveMany(PUSH_LIMITS.hostSendsPerRollingHour, 'reg-1')
    expect(decisions.every((decision) => decision === 'allowed')).toBe(true)
    await expect(quota.reserve(HOST, 'reg-1')).resolves.toBe('rate_limited')
  })

  it('lets the host window roll forward', async () => {
    await reserveMany(PUSH_LIMITS.hostSendsPerRollingHour, 'reg-1')
    clock += HOUR_MS
    await expect(quota.reserve(HOST, 'reg-1')).resolves.toBe('allowed')
  })

  it('limits a single registration across a rolling day even as hosts rotate', async () => {
    // Spread the day allowance across hours so the hourly host cap never binds.
    for (let index = 0; index < PUSH_LIMITS.registrationSendsPerRollingDay; index++) {
      expect(await quota.reserve(HOST, 'reg-1')).toBe('allowed')
      if ((index + 1) % PUSH_LIMITS.hostSendsPerRollingHour === 0) clock += HOUR_MS + 1
    }
    await expect(quota.reserve(HOST, 'reg-1')).resolves.toBe('rate_limited')
    await expect(quota.reserve(HOST, 'reg-2')).resolves.toBe('allowed')
    clock += DAY_MS
    await expect(quota.reserve(HOST, 'reg-1')).resolves.toBe('allowed')
  })

  it('never logs a send it refused', async () => {
    await reserveMany(PUSH_LIMITS.hostSendsPerRollingHour + 5, 'reg-1')
    const [row] = await database.query('SELECT COUNT(*) AS sends FROM push_send_log')
    expect(Number(row?.sends)).toBe(PUSH_LIMITS.hostSendsPerRollingHour)
  })

  it('prunes the log past the retention window only', async () => {
    await quota.reserve(HOST, 'reg-1')
    clock += PUSH_LIMITS.sendLogRetentionMs
    expect(await quota.prune()).toBe(0)
    clock += 1
    expect(await quota.prune()).toBe(1)
  })
})
