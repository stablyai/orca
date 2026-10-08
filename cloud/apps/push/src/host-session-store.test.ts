import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PushHostSessionStore } from './host-session-store.js'
import { openInMemoryPushDatabase, type PushDatabase } from './push-database.js'

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

  it('mints a 24 hour session and stores only its hash', async () => {
    const session = await sessions.create(HOST)
    expect(session.expiresAt).toBe(clock + PUSH_LIMITS.sessionTtlMs)
    expect(Buffer.from(session.sessionToken, 'base64url').byteLength).toBe(32)
    const [row] = await database.query('SELECT token_hash FROM push_sessions')
    expect(String(row?.token_hash)).not.toBe(session.sessionToken)
    await expect(sessions.resolve(session.sessionToken)).resolves.toMatchObject({
      ok: true,
      hostFingerprint: HOST
    })
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

  it('accepts a session on its final millisecond', async () => {
    const session = await sessions.create(HOST)
    clock += PUSH_LIMITS.sessionTtlMs
    await expect(sessions.resolve(session.sessionToken)).resolves.toMatchObject({ ok: true })
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
