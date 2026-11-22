import { createHash, timingSafeEqual } from 'node:crypto'

export const MAX_OBSERVER_LEDGER_BYTES = 512 * 1024
export const OBSERVER_LEDGER_NAME = 'observer-credentials.v1.json'
export const TOKEN_PREFIX = 'orca-observer-v1-'
const TOKEN_PATTERN = /^orca-observer-v1-[A-Za-z0-9_-]{43}$/

export function isObserverCredentialTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}
export const OBSERVER_LIFETIME_MS = 3_600_000
const CREDENTIAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isCanonicalObserverCredentialId(value: unknown): value is string {
  return typeof value === 'string' && CREDENTIAL_ID_PATTERN.test(value)
}

export type ObserverCredentialRow = {
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

export function validWorktreeId(value: unknown): value is string {
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

export function validWorktreeInstanceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

export function tokenHash(token: string): string {
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

export function decodeObserverLedger(text: string): ObserverCredentialRow[] {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid observer store')
  }
  if (!('version' in parsed) || !('credentials' in parsed)) {
    throw new Error('Invalid observer store')
  }
  const store = parsed
  if (Object.keys(store).length !== 2 || store.version !== 1 || !Array.isArray(store.credentials)) {
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

export function matchObserverCredential(
  rows: readonly ObserverCredentialRow[],
  token: string
): ObserverCredential | null {
  const expected = Buffer.from(tokenHash(token), 'hex')
  const row = rows.find((candidate) =>
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
}
