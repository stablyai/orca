import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  type BrowserCredentialEntry,
  type BrowserCredentialSaveOutcome,
  type BrowserCredentialVaultStatus,
  type SaveBrowserCredentialArgs,
  type StoredBrowserCredential,
  type UpdateBrowserCredentialArgs
} from '../../shared/browser-credential-types'
import {
  hostnameFromOrigin,
  normalizeCredentialOrigin
} from '../../shared/browser-credential-hostname'

export type CredentialVaultDeps = {
  filePath: string
  encryptionAvailable: () => boolean
  encrypt: (plaintext: string) => Buffer
  decrypt: (ciphertext: Buffer) => string
  now?: () => number
  generateId?: () => string
}

function toPublic(record: StoredBrowserCredential): BrowserCredentialEntry {
  const { encryptedPassword: _omit, ...rest } = record
  return rest
}

export class BrowserCredentialVault {
  private readonly deps: CredentialVaultDeps
  private readonly now: () => number
  private readonly generateId: () => string
  private records: StoredBrowserCredential[] | null = null

  constructor(deps: CredentialVaultDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.generateId = deps.generateId ?? (() => randomUUID())
  }

  status(): BrowserCredentialVaultStatus {
    return this.deps.encryptionAvailable()
      ? { available: true }
      : { available: false, reason: 'OS secure storage is unavailable on this system.' }
  }

  listAll(): BrowserCredentialEntry[] {
    return this.load().map(toPublic)
  }

  matchesForOrigin(origin: string): BrowserCredentialEntry[] {
    const host =
      hostnameFromOrigin(origin) ?? hostnameFromOrigin(normalizeCredentialOrigin(origin) ?? '')
    if (!host) {
      return []
    }
    return this.load()
      .filter((r) => r.hostname === host)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .map(toPublic)
  }

  reveal(id: string): string | null {
    const record = this.load().find((r) => r.id === id)
    if (!record) {
      return null
    }
    try {
      return this.deps.decrypt(Buffer.from(record.encryptedPassword, 'base64'))
    } catch {
      return null
    }
  }

  save(args: SaveBrowserCredentialArgs): {
    outcome: BrowserCredentialSaveOutcome
    entry: BrowserCredentialEntry | null
  } {
    const origin = normalizeCredentialOrigin(args.origin)
    if (
      !origin ||
      !this.deps.encryptionAvailable() ||
      args.username === '' ||
      args.password === ''
    ) {
      return { outcome: 'unchanged', entry: null }
    }
    const host = hostnameFromOrigin(origin)!
    const records = this.load()
    const existing = records.find((r) => r.hostname === host && r.username === args.username)
    if (existing) {
      if (this.reveal(existing.id) === args.password) {
        return { outcome: 'unchanged', entry: toPublic(existing) }
      }
      existing.encryptedPassword = this.encryptPassword(args.password)
      existing.updatedAt = this.now()
      this.flush()
      return { outcome: 'updated', entry: toPublic(existing) }
    }
    const created = this.makeRecord(origin, host, args.username, args.password)
    records.push(created)
    this.flush()
    return { outcome: 'created', entry: toPublic(created) }
  }

  add(args: SaveBrowserCredentialArgs): BrowserCredentialEntry | null {
    return this.save(args).entry
  }

  update(args: UpdateBrowserCredentialArgs): BrowserCredentialEntry | null {
    const record = this.load().find((r) => r.id === args.id)
    if (!record) {
      return null
    }
    if (args.username !== undefined && args.username !== '') {
      record.username = args.username
    }
    if (args.password !== undefined && args.password !== '') {
      if (!this.deps.encryptionAvailable()) {
        return null
      }
      record.encryptedPassword = this.encryptPassword(args.password)
    }
    record.updatedAt = this.now()
    this.flush()
    return toPublic(record)
  }

  delete(id: string): boolean {
    const records = this.load()
    const next = records.filter((r) => r.id !== id)
    if (next.length === records.length) {
      return false
    }
    this.records = next
    this.flush()
    return true
  }

  markUsed(id: string): void {
    const record = this.load().find((r) => r.id === id)
    if (!record) {
      return
    }
    record.lastUsedAt = this.now()
    this.flush()
  }

  private encryptPassword(plaintext: string): string {
    return this.deps.encrypt(plaintext).toString('base64')
  }

  private makeRecord(
    origin: string,
    hostname: string,
    username: string,
    password: string
  ): StoredBrowserCredential {
    const ts = this.now()
    return {
      id: this.generateId(),
      origin,
      hostname,
      username,
      encryptedPassword: this.encryptPassword(password),
      createdAt: ts,
      updatedAt: ts,
      lastUsedAt: null
    }
  }

  private load(): StoredBrowserCredential[] {
    if (this.records) {
      return this.records
    }
    try {
      const parsed = JSON.parse(readFileSync(this.deps.filePath, 'utf-8'))
      this.records = Array.isArray(parsed) ? (parsed as StoredBrowserCredential[]) : []
    } catch {
      this.records = []
    }
    return this.records
  }

  private flush(): void {
    const records = this.records ?? []
    mkdirSync(dirname(this.deps.filePath), { recursive: true })
    const tmp = `${this.deps.filePath}.tmp`
    // Why: 0600 + atomic rename matches terminal-scrollback-snapshots.ts so a
    // crash mid-write can never leave a world-readable half-written vault.
    writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 })
    renameSync(tmp, this.deps.filePath)
  }
}
