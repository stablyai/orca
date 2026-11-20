import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

type SessionScope = { sessionId: string; account: string }
export type BotToolRelayGrant = { botId: string; folder: string } & Partial<SessionScope>

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export class BotToolRelayGrants {
  private readonly grants = new Map<string, BotToolRelayGrant>()
  private readonly tokens = new Map<string, Map<string, string>>()

  issue(botId: string, folder: string, scope?: SessionScope): string {
    const key = JSON.stringify(scope ? [scope.account, scope.sessionId] : [])
    const tokens = this.tokens.get(botId) ?? new Map<string, string>()
    let token = tokens.get(key)
    if (!token) {
      token = randomBytes(32).toString('base64url')
      tokens.set(key, token)
      this.tokens.set(botId, tokens)
    }
    this.grants.set(hashToken(token), { botId, folder: resolve(folder), ...scope })
    return token
  }

  authenticate(token: string): BotToolRelayGrant | undefined {
    return this.grants.get(hashToken(token))
  }

  revoke(botId: string): void {
    for (const token of this.tokens.get(botId)?.values() ?? []) {
      this.grants.delete(hashToken(token))
    }
    this.tokens.delete(botId)
  }

  clear(): void {
    this.grants.clear()
    this.tokens.clear()
  }
}
