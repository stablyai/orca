// Who may use Orca's relay, and where each tool sits on it. A bot's token reaches its
// home's tools under /bot-tools; the host's token, shared by every non-bot session, reaches the host
// MCP list's under /mcp-servers, and its command servers Orca runs once under /mcp-processes. A bot
// that takes the host list reaches all of them with its own token.
import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import {
  relaySealingProtected,
  sealRelaySecret,
  unsealRelaySecret,
  type RelaySealedFile
} from './relay-sealed-file'

/** The folders a token reaches: its bot's home, and the host's MCP server list when it may use it. */
export type RelayFolders = { bot?: string; host?: string }

/** Whom a token was granted to: a bot, or every other session (`MCP_HOST_LIST_RELAY_OWNER`). */
export type RelayGrant = { owner: string; folders: RelayFolders }

/** The one owner every non-bot session's grant is under; it never names a bot (bot ids are UUIDs). */
export const MCP_HOST_LIST_RELAY_OWNER = 'mcp-host-list'

const PATH = /^\/(bot-tools|mcp-servers|mcp-processes)\/([A-Za-z0-9_-]{8,64})\/mcp(?:\?.*)?$/

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** A tool's relay address. */
export function relayToolUrl(
  origin: string,
  scope: keyof RelayFolders,
  credentialId: string
): string {
  return `${origin}/${scope === 'bot' ? 'bot-tools' : 'mcp-servers'}/${credentialId}/mcp`
}

/** A host list command server's address: Orca runs it once on the host for every session. */
export function relayProcessUrl(origin: string, serverId: string): string {
  return `${origin}/mcp-processes/${serverId}/mcp`
}

/** What a request path names; null for any other path. */
export type RelayToolPath =
  /** A tool whose saved values Orca adds, by its credential id, in its grant's folder. */
  | { scope: keyof RelayFolders; credentialId: string; process?: undefined }
  /** A command server in the host's list that Orca runs once, by its id. */
  | { scope: 'host'; process: string; credentialId?: undefined }

export function relayToolPath(path: string): RelayToolPath | null {
  const match = PATH.exec(path)
  if (!match) {
    return null
  }
  if (match[1] === 'mcp-processes') {
    return { scope: 'host', process: match[2]! }
  }
  return { scope: match[1] === 'mcp-servers' ? 'host' : 'bot', credentialId: match[2]! }
}

/** A kept grant as the file holds it; only the token is sealed (by the OS keychain). */
export type StoredRelayGrant = { owner: string; folders: RelayFolders; sealedToken: string }

export function isStoredRelayGrant(value: unknown): value is StoredRelayGrant {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const entry = value as Record<string, unknown>
  const folders = entry.folders as Record<string, unknown> | null | undefined
  return (
    typeof entry.owner === 'string' &&
    entry.owner.length > 0 &&
    typeof entry.sealedToken === 'string' &&
    typeof folders === 'object' &&
    folders !== null &&
    (folders.bot === undefined || typeof folders.bot === 'string') &&
    (folders.host === undefined || typeof folders.host === 'string')
  )
}

/** How often a call may retry opening sealed tokens the keychain refused. */
export const RELAY_UNLOCK_RETRY_MS = 10_000

const resolvedFolders = (folders: RelayFolders): RelayFolders => ({
  ...(folders.bot ? { bot: resolve(folders.bot) } : {}),
  ...(folders.host ? { host: resolve(folders.host) } : {})
})

/**
 * One token per owner; only a hash of it is the grant's key. A kept owner's token is sealed in the
 * grants file, so agents still running from an earlier run of Orca keep using it.
 */
export class RelayGrants {
  private readonly grants = new Map<string, RelayGrant>()
  /** The token each owner's launches get now. */
  private readonly tokens = new Map<string, string>()
  /** Owners whose token is durably in the file, with the token it holds. */
  private readonly kept = new Map<string, { entry: StoredRelayGrant; token: string }>()
  /** Entries in the file the keychain hasn't opened yet; kept as written. */
  private readonly locked = new Map<string, StoredRelayGrant>()
  private lastUnlockAt = Number.NEGATIVE_INFINITY
  private loading: Promise<void> | null = null
  private file: RelaySealedFile<StoredRelayGrant> | null = null
  private current: ((owner: string) => RelayFolders | null) | undefined

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Where kept grants live; without one every grant ends with this run, as before. `current` is
   * each owner's reach from the current config, null for a deleted bot; absent keeps the file's.
   */
  configure(
    file: RelaySealedFile<StoredRelayGrant>,
    current?: (owner: string) => RelayFolders | null
  ): void {
    this.file = file
    this.current = current
  }

  get configured(): boolean {
    return this.file !== null
  }

  /** Opens the file's tokens once, before any call is served or the file is written. */
  load(): Promise<void> {
    this.loading ??= this.loadOnce()
    return this.loading
  }

  private async loadOnce(): Promise<void> {
    const { file, current } = this
    if (!file) {
      return
    }
    let dropped = false
    for (const stored of await file.read()) {
      const folders = current ? current(stored.owner) : stored.folders
      if (!folders || this.kept.has(stored.owner) || this.locked.has(stored.owner)) {
        dropped = true
        continue
      }
      const entry = { ...stored, folders: resolvedFolders(folders) }
      if (!this.open(entry)) {
        this.locked.set(entry.owner, entry)
      }
    }
    if (dropped) {
      await this.persist().catch((error: unknown) =>
        console.warn('[bot-tool-relay] could not drop deleted bots from the grants file', error)
      )
    }
  }

  /** The owner's token, now reaching only `folders`, as the owner's latest launch named them. */
  grant(owner: string, folders: RelayFolders): string {
    let token = this.tokens.get(owner)
    if (!token) {
      token = randomBytes(32).toString('base64url')
      this.tokens.set(owner, token)
    }
    this.grants.set(hashToken(token), { owner, folders: resolvedFolders(folders) })
    return token
  }

  /**
   * Whether the owner's current token outlives this run: sealed by the OS keychain and durably in
   * the file before this resolves. False keeps it memory-only (its launch is app-bound, as before).
   */
  async keep(owner: string): Promise<boolean> {
    await this.load()
    const token = this.tokens.get(owner)
    const grant = token ? this.grants.get(hashToken(token)) : undefined
    if (!this.file || !token || !grant || this.locked.has(owner) || !relaySealingProtected()) {
      return false
    }
    if (this.kept.get(owner)?.token === token) {
      return true
    }
    const entry = { owner, folders: grant.folders, sealedToken: await sealRelaySecret(token) }
    this.kept.set(owner, { entry, token })
    try {
      await this.persist()
      return this.kept.get(owner)?.token === token
    } catch (error) {
      if (this.kept.get(owner)?.token === token) {
        this.kept.delete(owner)
      }
      console.warn('[bot-tool-relay] could not keep a grant', error)
      return false
    }
  }

  /** The owner has a grant in the file (opened or not). */
  holds(owner: string): boolean {
    return this.kept.has(owner) || this.locked.has(owner)
  }

  of(token: string): RelayGrant | undefined {
    return this.grants.get(hashToken(token))
  }

  /**
   * An unknown token while some kept token is still locked: one retry per `RELAY_UNLOCK_RETRY_MS`
   * across all callers. `locked` while any stays locked, so its agents hear to try again.
   */
  unlock(token: string): RelayGrant | 'locked' | undefined {
    if (this.locked.size === 0) {
      return undefined
    }
    if (this.now() - this.lastUnlockAt < RELAY_UNLOCK_RETRY_MS) {
      return 'locked'
    }
    this.lastUnlockAt = this.now()
    for (const entry of [...this.locked.values()]) {
      if (this.open(entry)) {
        this.locked.delete(entry.owner)
      }
    }
    return this.of(token) ?? (this.locked.size > 0 ? 'locked' : undefined)
  }

  /** The owner's token stops working: its file entry goes durably first, then every token of it. */
  async revoke(owner: string): Promise<void> {
    await this.load().catch(() => {})
    const inFile = this.kept.delete(owner) || this.locked.delete(owner)
    try {
      if (inFile) {
        await this.persist()
      }
    } finally {
      // A failed write still ends the token now; the next start drops a deleted bot's entry.
      for (const [hash, grant] of this.grants) {
        if (grant.owner === owner) {
          this.grants.delete(hash)
        }
      }
      this.tokens.delete(owner)
    }
  }

  /** Forgets this run's memory; the file stays for the next run. */
  clear(): void {
    this.grants.clear()
    this.tokens.clear()
  }

  /** Opens a stored token: it becomes the owner's current one, as the file holds it. */
  private open(entry: StoredRelayGrant): boolean {
    let token: string
    try {
      token = unsealRelaySecret(entry.sealedToken)
    } catch {
      return false
    }
    this.grants.set(hashToken(token), { owner: entry.owner, folders: entry.folders })
    this.tokens.set(entry.owner, token)
    this.kept.set(entry.owner, { entry, token })
    return true
  }

  private persist(): Promise<void> {
    if (!this.file) {
      return Promise.resolve()
    }
    return this.file.write([
      ...[...this.kept.values()].map(({ entry }) => entry),
      ...this.locked.values()
    ])
  }
}
