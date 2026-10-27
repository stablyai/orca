// Observer credentials never enter device-registry.json. Older Orca builds do not read this file
// and therefore cannot reinterpret a new observer scope as a mutable mobile or runtime device.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hardenExistingSecureFile, writeDurableSecureJsonFile } from '../../shared/secure-file'

const FILE_NAME = 'observer-credentials.v1.json'
const TOKEN_PREFIX = 'orca-observer-v1-'
const TOKEN_PATTERN = /^orca-observer-v1-[A-Za-z0-9_-]{43}$/

export function isObserverCredentialTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}
const OBSERVER_LIFETIME_MS = 3_600_000
const CREDENTIAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isCanonicalObserverCredentialId(value: unknown): value is string {
  return typeof value === 'string' && CREDENTIAL_ID_PATTERN.test(value)
}

type ObserverCredentialRow = {
  id: string
  tokenHash: string
  createdAt: number
  worktreeId: string
  worktreeInstanceId: string
  expiresAt: number
}

export type ObserverCredential = {
  id: string
  tokenHash: string
  worktreeId: string
  worktreeInstanceId: string
  expiresAt: number
}

function validWorktreeId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    return false
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) {
      return false
    }
  }
  return true
}

function validWorktreeInstanceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function validRow(value: unknown): value is ObserverCredentialRow {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (
    !('id' in value) ||
    !('tokenHash' in value) ||
    !('createdAt' in value) ||
    !('worktreeId' in value) ||
    !('worktreeInstanceId' in value) ||
    !('expiresAt' in value)
  ) {
    return false
  }
  const row = value
  if (
    Object.keys(row).length !== 6 ||
    !Object.keys(row).every((key) =>
      ['id', 'tokenHash', 'createdAt', 'worktreeId', 'worktreeInstanceId', 'expiresAt'].includes(
        key
      )
    )
  ) {
    return false
  }
  return (
    isCanonicalObserverCredentialId(row.id) &&
    typeof row.tokenHash === 'string' &&
    /^[0-9a-f]{64}$/.test(row.tokenHash) &&
    typeof row.createdAt === 'number' &&
    Number.isSafeInteger(row.createdAt) &&
    row.createdAt > 0 &&
    validWorktreeId(row.worktreeId) &&
    validWorktreeInstanceId(row.worktreeInstanceId) &&
    typeof row.expiresAt === 'number' &&
    Number.isSafeInteger(row.expiresAt) &&
    row.expiresAt > row.createdAt &&
    row.expiresAt - row.createdAt <= OBSERVER_LIFETIME_MS
  )
}

export class ObserverCredentialStore {
  private readonly path: string

  constructor(userDataPath: string) {
    this.path = join(userDataPath, FILE_NAME)
  }

  private withWriteLock<T>(work: () => T): T {
    // Serializes owner-local issue/revoke processes. A crash leaves the lock and fails closed
    // until the owner inspects it; silently breaking a stale lock could resurrect a revoked row.
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    hardenExistingSecureFile(this.path)
    const lockPath = `${this.path}.lock`
    const descriptor = openSync(lockPath, 'wx', 0o600)
    try {
      return work()
    } finally {
      closeSync(descriptor)
      unlinkSync(lockPath)
    }
  }

  private readRows(): ObserverCredentialRow[] {
    let text: string
    try {
      hardenExistingSecureFile(this.path)
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return []
      }
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Invalid observer store')
    }
    if (!('version' in parsed) || !('credentials' in parsed)) {
      throw new Error('Invalid observer store')
    }
    const store = parsed
    if (
      Object.keys(store).length !== 2 ||
      store.version !== 1 ||
      !Array.isArray(store.credentials)
    ) {
      throw new Error('Invalid observer store')
    }
    // Older candidate rows without a complete scope or expiry must never become live bearers.
    // Keep the old file intact and require an owner-local fresh path and reissue.
    if (
      store.credentials.some(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          (!('worktreeId' in value) || !('worktreeInstanceId' in value) || !('expiresAt' in value))
      )
    ) {
      throw new Error('Incomplete observer store requires fresh path and reissue')
    }
    if (!store.credentials.every(validRow)) {
      throw new Error('Invalid observer store')
    }
    const rows = store.credentials.filter(validRow)
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new Error('Duplicate observer credential id')
    }
    return rows
  }

  /** The bearer is returned once, only after its hash is durably stored. */
  issue(worktreeId: string, worktreeInstanceId: string): { id: string; token: string } {
    if (!validWorktreeId(worktreeId) || !validWorktreeInstanceId(worktreeInstanceId)) {
      throw new Error('Invalid observer worktree scope or instance')
    }
    return this.withWriteLock(() => {
      const rows = this.readRows()
      const id = randomUUID()
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
      const createdAt = Date.now()
      const expiresAt = createdAt + OBSERVER_LIFETIME_MS
      if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt)) {
        throw new Error('Invalid observer credential clock')
      }
      if (
        !writeDurableSecureJsonFile(this.path, {
          version: 1,
          credentials: [
            ...rows,
            {
              id,
              tokenHash: tokenHash(token),
              createdAt,
              worktreeId,
              worktreeInstanceId,
              expiresAt
            }
          ]
        })
      ) {
        throw new Error('Observer credential store could not be secured')
      }
      return { id, token }
    })
  }

  revoke(id: string): boolean {
    if (!isCanonicalObserverCredentialId(id)) {
      throw new Error('Invalid observer credential id')
    }
    return this.withWriteLock(() => {
      const rows = this.readRows()
      if (!rows.some((row) => row.id === id)) {
        return false
      }
      if (
        !writeDurableSecureJsonFile(this.path, {
          version: 1,
          credentials: rows.filter((row) => row.id !== id)
        })
      ) {
        throw new Error('Observer credential revocation could not be secured')
      }
      return true
    })
  }

  /** Any missing, unreadable, or malformed store fails closed for admission. */
  authenticate(token: string): ObserverCredential | null {
    if (!isObserverCredentialTokenShape(token)) {
      return null
    }
    try {
      const expected = Buffer.from(tokenHash(token), 'hex')
      const row = this.readRows().find((candidate) =>
        timingSafeEqual(Buffer.from(candidate.tokenHash, 'hex'), expected)
      )
      if (!row || row.expiresAt <= Date.now()) {
        return null
      }
      return {
        id: row.id,
        tokenHash: row.tokenHash,
        worktreeId: row.worktreeId,
        worktreeInstanceId: row.worktreeInstanceId,
        expiresAt: row.expiresAt
      }
    } catch {
      return null
    }
  }

  resolve(id: string, token: string): ObserverCredential | null {
    const credential = this.authenticate(token)
    return credential?.id === id ? credential : null
  }
}
