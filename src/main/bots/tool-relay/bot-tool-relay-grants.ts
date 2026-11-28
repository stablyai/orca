// Who may use Orca's relay in this run, and where each tool sits on it. A bot's token reaches its
// home's tools under /bot-tools; the host's token, shared by every non-bot session, reaches the host
// MCP list's under /mcp-servers, and its command servers Orca runs once under /mcp-processes. A bot
// that takes the host list reaches all of them with its own token.
import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

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

/** One token per owner for this run of Orca; only a hash of it is kept as the grant's key. */
export class RelayGrants {
  private readonly grants = new Map<string, RelayGrant>()
  private readonly tokens = new Map<string, string>()

  /** The owner's token, now reaching only `folders`, as the owner's latest launch named them. */
  grant(owner: string, folders: RelayFolders): string {
    let token = this.tokens.get(owner)
    if (!token) {
      token = randomBytes(32).toString('base64url')
      this.tokens.set(owner, token)
    }
    this.grants.set(hashToken(token), {
      owner,
      folders: {
        ...(folders.bot ? { bot: resolve(folders.bot) } : {}),
        ...(folders.host ? { host: resolve(folders.host) } : {})
      }
    })
    return token
  }

  of(token: string): RelayGrant | undefined {
    return this.grants.get(hashToken(token))
  }

  /** The owner's token stops working. */
  revoke(owner: string): void {
    const token = this.tokens.get(owner)
    if (token) {
      this.grants.delete(hashToken(token))
      this.tokens.delete(owner)
    }
  }

  clear(): void {
    this.grants.clear()
    this.tokens.clear()
  }
}
