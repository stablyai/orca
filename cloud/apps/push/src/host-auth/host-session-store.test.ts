import { PUSH_LIMITS } from '@orca-cloud/push-contract/push-limits'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PushHostSessionStore } from './host-session-store.js'
import { openInMemoryPushDatabase } from '../database/push-database.js'
import type { CloudDatabase as PushDatabase } from '@orca-cloud/cloud-database/cloud-database'

const HOST = 'abcdefghijklmnop'

describe('push host session store', () => {
  let database: PushDatabase
  let clock = 1_700_000_000_000
  let sessions: PushHostSessionStore

  beforeEach(async () => {
    database = await openInMemoryPushDatabase()
    clock = 1_700_000_000_000
    sessions = new PushHostSessionStore(database, () => clock)
  })

  afterEach(async () => {
    await database.close()
  })

  it('reports expiry separately from an unknown token', async () => {
    const session = await sessions.create(HOST)
    clock += PUSH_LIMITS.sessionTtlMs + 1
    await expect(sessions.resolve(session.sessionToken)).resolves.toEqual({
      ok: false,
      reason: 'session_expired'
    })
    await expect(sessions.resolve('not-a-session')).resolves.toEqual({
      ok: false,
      reason: 'unknown_session'
    })
  })

  it('keeps one live session per host and prunes it once expired', async () => {
    const first = await sessions.create(HOST)
    const second = await sessions.create(HOST)
    // The earlier session is gone the moment its host proves again, so a flood
    // of proofs leaves one row per host rather than one per proof.
    await expect(sessions.resolve(first.sessionToken)).resolves.toEqual({
      ok: false,
      reason: 'unknown_session'
    })
    await expect(sessions.resolve(second.sessionToken)).resolves.toMatchObject({ ok: true })
    const other = await sessions.create('ponmlkjihgfedcba')
    await expect(sessions.resolve(second.sessionToken)).resolves.toMatchObject({ ok: true })
    clock += PUSH_LIMITS.sessionTtlMs + 1
    expect(await sessions.pruneExpired()).toBe(2)
    await expect(sessions.resolve(other.sessionToken)).resolves.toMatchObject({ ok: false })
  })
})
