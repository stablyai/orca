// Who may use Orca's relay in this run, and where each tool sits on it. A bot's token reaches its
// home's tools under /bot-tools; the host's token, shared by every non-bot session, reaches the host
// MCP list's under /mcp-servers, and its command servers Orca runs once under /mcp-processes. A bot
// that takes the host list reaches all of them with its own token.
import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

/** The folders a token reaches: its bot's home, and the host's MCP server list when it may use it. */
export type RelayFolders = { bot?: string; host?: string }

/** The chat a bot's token was granted for, so a tool call can be tied back to it. */
export type RelaySessionScope = { sessionId: string; account: string }

/** Whom a token was granted to: a bot, or every other session (`MCP_HOST_LIST_RELAY_OWNER`). */
export type RelayGrant = { owner: string; folders: RelayFolders } & Partial<RelaySessionScope>

/** The one owner every non-bot session's grant is under; it never names a bot (bot ids are UUIDs). */
export const MCP_HOST_LIST_RELAY_OWNER = 'mcp-host-list'

/** Ties a bot chat's tool calls to that chat (SPC); a bot it claims gets a token per chat. */
export type BotToolRequestBinding = {
  accountForBot: (botId: string) => string | null
  bind: (url: string, grant: RelayGrant, body: Buffer) => Buffer
}

let requestBinding: BotToolRequestBinding | null = null

export function setRelayRequestBinding(binding: BotToolRequestBinding | null): void {
  requestBinding = binding
}

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

/** One token per owner, or per owner and chat, for this run of Orca; only its hash keys the grant. */
export class RelayGrants {
  private readonly grants = new Map<string, RelayGrant>()
  private readonly tokens = new Map<string, Map<string, string>>()

  /**
   * The owner's token, now reaching only `folders`, as the owner's latest launch named them. A bot
   * the request binding claims gets its own token for each chat `sessionId`.
   */
  grant(owner: string, folders: RelayFolders, sessionId?: string): string {
    const account = sessionId ? requestBinding?.accountForBot(owner) : null
    const scope: RelaySessionScope | undefined =
      account && sessionId ? { account, sessionId } : undefined
    const key = JSON.stringify(scope ? [scope.account, scope.sessionId] : [])
    const tokens = this.tokens.get(owner) ?? new Map<string, string>()
    let token = tokens.get(key)
    if (!token) {
      token = randomBytes(32).toString('base64url')
      tokens.set(key, token)
      this.tokens.set(owner, tokens)
    }
    this.grants.set(hashToken(token), {
      owner,
      folders: {
        ...(folders.bot ? { bot: resolve(folders.bot) } : {}),
        ...(folders.host ? { host: resolve(folders.host) } : {})
      },
      ...scope
    })
    return token
  }

  /** `body` as the request binding sends it on to `url`. */
  bound(url: string, grant: RelayGrant, body: Buffer | undefined): Buffer | undefined {
    return body && requestBinding ? requestBinding.bind(url, grant, body) : body
  }

  of(token: string): RelayGrant | undefined {
    return this.grants.get(hashToken(token))
  }

  /** Every token of the owner stops working. */
  revoke(owner: string): void {
    for (const token of this.tokens.get(owner)?.values() ?? []) {
      this.grants.delete(hashToken(token))
    }
    this.tokens.delete(owner)
  }

  clear(): void {
    this.grants.clear()
    this.tokens.clear()
  }
}
