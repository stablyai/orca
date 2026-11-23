import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  hardenExistingSecureFile,
  writeSecureFile
} from '../../src/shared/secure-storage/secure-file'
import {
  decodeObserverLedger,
  isCanonicalObserverCredentialId,
  MAX_OBSERVER_LEDGER_BYTES,
  OBSERVER_LEDGER_NAME,
  OBSERVER_LIFETIME_MS,
  TOKEN_PREFIX,
  tokenHash,
  validWorktreeId,
  validWorktreeInstanceId,
  type ObserverCredentialRow
} from '../../src/main/runtime/observer-credential-ledger'

export class ObserverCredentialAdminStore {
  private readonly path: string

  constructor(userDataPath: string) {
    this.path = join(userDataPath, OBSERVER_LEDGER_NAME)
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
    return decodeObserverLedger(text)
  }

  private writeRows(ledger: { version: 1; credentials: ObserverCredentialRow[] }): boolean {
    const json = JSON.stringify(ledger, null, 2)
    if (Buffer.byteLength(json) > MAX_OBSERVER_LEDGER_BYTES) {
      throw new Error('Observer credential store capacity reached')
    }
    return writeSecureFile(this.path, json, { ownerOnly: true, durable: true })
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
        !this.writeRows({
          version: 1,
          credentials: [
            ...rows.filter((row) => row.expiresAt > createdAt),
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
        !this.writeRows({
          version: 1,
          credentials: rows.filter((row) => row.id !== id)
        })
      ) {
        throw new Error('Observer credential revocation could not be secured')
      }
      return true
    })
  }
}
