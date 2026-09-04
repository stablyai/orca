import { createHash, randomBytes } from 'node:crypto'
import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import type { PushDatabase } from './push-database.js'

export type IssuedPushSession = {
  sessionToken: string
  expiresAt: number
  hostFingerprint: string
}

export type PushSessionLookup =
  | { ok: true; hostFingerprint: string; expiresAt: number }
  | { ok: false; reason: 'unknown_session' | 'session_expired' }

function hashSessionToken(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('base64url')
}

export class PushHostSessionStore {
  constructor(
    private readonly database: PushDatabase,
    private readonly now: () => number = Date.now
  ) {}

  async create(hostFingerprint: string): Promise<IssuedPushSession> {
    const sessionToken = randomBytes(32).toString('base64url')
    const createdAt = this.now()
    const expiresAt = createdAt + PUSH_LIMITS.sessionTtlMs
    await this.database.query(
      `INSERT INTO push_sessions (token_hash, host_fingerprint, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
      [hashSessionToken(sessionToken), hostFingerprint, expiresAt, createdAt]
    )
    return { sessionToken, expiresAt, hostFingerprint }
  }

  async resolve(sessionToken: string): Promise<PushSessionLookup> {
    const [row] = await this.database.query(
      'SELECT host_fingerprint, expires_at FROM push_sessions WHERE token_hash = ?',
      [hashSessionToken(sessionToken)]
    )
    if (!row) return { ok: false, reason: 'unknown_session' }
    const expiresAt = Number(row.expires_at)
    // No skew grace here: a 24h session that just expired should be re-minted
    // through the challenge, which is cheap and already handled by the host.
    if (this.now() > expiresAt) return { ok: false, reason: 'session_expired' }
    return { ok: true, hostFingerprint: String(row.host_fingerprint), expiresAt }
  }

  async revokeForHost(hostFingerprint: string): Promise<number> {
    const [result] = await this.database.query(
      'DELETE FROM push_sessions WHERE host_fingerprint = ?',
      [hostFingerprint]
    )
    return Number(result?.changes ?? 0)
  }

  async pruneExpired(): Promise<number> {
    const [result] = await this.database.query('DELETE FROM push_sessions WHERE expires_at < ?', [
      this.now()
    ])
    return Number(result?.changes ?? 0)
  }
}
