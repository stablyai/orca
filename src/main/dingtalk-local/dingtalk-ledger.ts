import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as z from 'zod'
import {
  schemas,
  type ConversationRow,
  type DingTalkLedgerState,
  type InboxRow,
  type InboxState,
  type ReplyRow,
  type ReplyState
} from './dingtalk-domain'

const Inbound = z.object({
  profile: schemas.Profile,
  source: z.enum(['at', 'group']),
  groupId: schemas.GroupId,
  conversationId: schemas.ConversationId,
  messageId: schemas.MessageId,
  senderOpenId: z.string(),
  senderName: z.string(),
  content: z.string(),
  createTime: z.string()
})
const InboxRowSchema = z.object({
  key: z.string().min(1),
  event: Inbound,
  externalId: schemas.ExternalId,
  body: z.string(),
  state: z.enum(['pending', 'delivering', 'delivered', 'attributed', 'filtered', 'failed']),
  deliveryId: schemas.DeliveryId,
  reason: z.string(),
  updatedAt: z.number()
})
const ConversationRowSchema = z.object({
  externalId: schemas.ExternalId,
  profile: schemas.Profile,
  groupId: schemas.GroupId,
  conversationId: schemas.ConversationId,
  botId: z.string().min(1),
  sessionId: z.string(),
  latestMessageId: schemas.MessageId,
  updatedAt: z.number()
})
const ReplyRowSchema = z.object({
  key: schemas.ReplyId,
  externalId: schemas.ExternalId,
  profile: schemas.Profile,
  groupId: schemas.GroupId,
  text: z.string(),
  uuid: z.string().min(1),
  turnId: z.number(),
  state: z.enum(['queued', 'sending', 'sent', 'uncertain', 'failed']),
  error: z.string(),
  updatedAt: z.number()
})
const Ledger = z.object({
  version: z.literal(1),
  inbox: z.record(z.string(), InboxRowSchema),
  conversations: z.record(z.string(), ConversationRowSchema),
  replies: z.record(z.string(), ReplyRowSchema),
  watermarks: z.record(z.string(), z.string())
}) satisfies z.ZodType<DingTalkLedgerState>

const empty = (): DingTalkLedgerState => ({
  version: 1,
  inbox: {},
  conversations: {},
  replies: {},
  watermarks: {}
})

export type LedgerSnapshot = Readonly<DingTalkLedgerState>

function clone(state: DingTalkLedgerState): DingTalkLedgerState {
  return structuredClone(state)
}

export class DingTalkLedger {
  private state: DingTalkLedgerState
  private writing = false
  /** Why an existing ledger could not be loaded; writes stay refused so the file is kept for diagnosis. */
  readonly readError: string | null

  constructor(private readonly filePath: string) {
    const loaded = this.read()
    this.state = loaded.state
    this.readError = loaded.error
  }

  snapshot(): LedgerSnapshot {
    return clone(this.state)
  }

  putInbox(row: InboxRow): boolean {
    if (this.state.inbox[row.key]) {
      return false
    }
    this.commit((next) => {
      next.inbox[row.key] = row
    })
    return true
  }

  putConversation(row: ConversationRow): void {
    this.commit((next) => {
      next.conversations[row.externalId] = row
    })
  }

  putReply(row: ReplyRow): boolean {
    if (this.state.replies[row.key]) {
      return false
    }
    this.commit((next) => {
      next.replies[row.key] = row
    })
    return true
  }

  transitionInbox(
    key: string,
    expected: InboxState,
    next: InboxState,
    patch: Partial<InboxRow> = {}
  ): InboxRow {
    const row = this.state.inbox[key]
    if (!row) {
      throw new Error(`inbox row not found ${key}`)
    }
    if (row.state !== expected) {
      throw new Error(`inbox row ${key} expected ${expected}, got ${row.state}`)
    }
    const updated = { ...row, ...patch, state: next, updatedAt: Date.now() }
    this.commit((candidate) => {
      candidate.inbox[key] = updated
    })
    return updated
  }

  transitionReply(
    key: string,
    expected: ReplyState,
    next: ReplyState,
    patch: Partial<ReplyRow> = {}
  ): ReplyRow {
    const row = this.state.replies[key]
    if (!row) {
      throw new Error(`reply row not found ${key}`)
    }
    if (row.state !== expected) {
      throw new Error(`reply row ${key} expected ${expected}, got ${row.state}`)
    }
    const updated = { ...row, ...patch, state: next, updatedAt: Date.now() }
    this.commit((candidate) => {
      candidate.replies[key] = updated
    })
    return updated
  }

  setWatermark(key: string, value: string): void {
    this.commit((next) => {
      next.watermarks[key] = value
    })
  }

  // Memory changes only after the write lands, so a failed write can be retried.
  private commit(mutate: (next: DingTalkLedgerState) => void): void {
    if (this.readError) {
      throw new Error(`DingTalk ledger unreadable: ${this.readError}`)
    }
    const next = clone(this.state)
    mutate(next)
    this.persist(next)
    this.state = next
  }

  private read(): { state: DingTalkLedgerState; error: string | null } {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: empty(), error: null }
      }
      return { state: empty(), error: error instanceof Error ? error.message : String(error) }
    }
    try {
      return { state: Ledger.parse(JSON.parse(text)), error: null }
    } catch (error) {
      return { state: empty(), error: error instanceof Error ? error.message : String(error) }
    }
  }

  private persist(state: DingTalkLedgerState): void {
    if (this.writing) {
      throw new Error('DingTalk ledger write re-entry')
    }
    this.writing = true
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      chmodSync(dirname(this.filePath), 0o700)
      const temporary = `${this.filePath}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.filePath)
    } finally {
      this.writing = false
    }
  }
}
