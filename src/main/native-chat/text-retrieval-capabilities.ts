import { createHash, randomBytes } from 'node:crypto'
import type { AgentType } from '../../shared/native-chat-types'

const MAX_GRANTS = 16_384
const GRANT_TTL_MS = 2 * 60 * 60 * 1000

export type NativeChatTextRetrievalGrant = {
  owner: string
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  messageId: string
  recordOffset: number
  blockIndex: number
  originalChars: number
  digest: string
  expiresAt: number
}

type IssueGrantArgs = Omit<NativeChatTextRetrievalGrant, 'digest' | 'expiresAt'> & {
  text: string
}

export class NativeChatTextRetrievalCapabilities {
  private readonly grants = new Map<string, NativeChatTextRetrievalGrant>()

  issue(args: IssueGrantArgs, now = Date.now()): string {
    this.ensureCapacity(now)
    const capability = randomBytes(32).toString('base64url')
    this.grants.set(capability, {
      owner: args.owner,
      agent: args.agent,
      sessionId: args.sessionId,
      ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {}),
      messageId: args.messageId,
      recordOffset: args.recordOffset,
      blockIndex: args.blockIndex,
      originalChars: args.originalChars,
      digest: nativeChatTextDigest(args.text),
      expiresAt: now + GRANT_TTL_MS
    })
    return capability
  }

  redeem(capability: string, owner: string, now = Date.now()): NativeChatTextRetrievalGrant | null {
    const grant = this.grants.get(capability)
    if (!grant || grant.owner !== owner || grant.expiresAt <= now) {
      if (grant?.expiresAt && grant.expiresAt <= now) {
        this.grants.delete(capability)
      }
      return null
    }
    return grant
  }

  private ensureCapacity(now: number): void {
    if (this.grants.size < MAX_GRANTS) {
      return
    }
    for (const [capability, grant] of this.grants) {
      if (grant.expiresAt <= now) {
        this.grants.delete(capability)
      }
    }
    while (this.grants.size >= MAX_GRANTS) {
      const oldest = this.grants.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.grants.delete(oldest)
    }
  }
}

export const nativeChatTextRetrievalCapabilities = new NativeChatTextRetrievalCapabilities()

export function nativeChatTextDigest(text: string): string {
  return createHash('sha256').update(text).digest('base64url')
}
