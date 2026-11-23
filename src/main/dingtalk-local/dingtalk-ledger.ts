import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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

type Change<T> = { result: T; write: boolean }

export class DingTalkLedger {
  private state: DingTalkLedgerState = empty()
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()
  /** Why an existing ledger could not be loaded; writes stay refused so the file is kept for diagnosis. */
  readError: string | null = null

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) {
      return
    }
    const read = await this.read()
    this.state = read.state
    this.readError = read.error
    this.loaded = true
  }

  snapshot(): LedgerSnapshot {
    return clone(this.state)
  }

  putInbox(row: InboxRow): Promise<boolean> {
    return this.commit((next) => {
      if (next.inbox[row.key]) {
        return { result: false, write: false }
      }
      next.inbox[row.key] = row
      return { result: true, write: true }
    })
  }

  putConversation(row: ConversationRow): Promise<void> {
    return this.commit((next) => {
      next.conversations[row.externalId] = row
      return { result: undefined, write: true }
    })
  }

  putReply(row: ReplyRow): Promise<boolean> {
    return this.commit((next) => {
      if (next.replies[row.key]) {
        return { result: false, write: false }
      }
      next.replies[row.key] = row
      return { result: true, write: true }
    })
  }

  transitionInbox(
    key: string,
    expected: InboxState,
    state: InboxState,
    patch: Partial<InboxRow> = {}
  ): Promise<InboxRow> {
    return this.commit((next) => {
      const row = next.inbox[key]
      if (!row) {
        throw new Error(`inbox row not found ${key}`)
      }
      if (row.state !== expected) {
        throw new Error(`inbox row ${key} expected ${expected}, got ${row.state}`)
      }
      const updated = { ...row, ...patch, state, updatedAt: Date.now() }
      next.inbox[key] = updated
      return { result: updated, write: true }
    })
  }

  transitionReply(
    key: string,
    expected: ReplyState,
    state: ReplyState,
    patch: Partial<ReplyRow> = {}
  ): Promise<ReplyRow> {
    return this.commit((next) => {
      const row = next.replies[key]
      if (!row) {
        throw new Error(`reply row not found ${key}`)
      }
      if (row.state !== expected) {
        throw new Error(`reply row ${key} expected ${expected}, got ${row.state}`)
      }
      const updated = { ...row, ...patch, state, updatedAt: Date.now() }
      next.replies[key] = updated
      return { result: updated, write: true }
    })
  }

  setWatermark(key: string, value: string): Promise<void> {
    return this.commit((next) => {
      next.watermarks[key] = value
      return { result: undefined, write: true }
    })
  }

  // Changes run one at a time and reach memory only after the write lands, so a failed write can be retried.
  private commit<T>(change: (next: DingTalkLedgerState) => Change<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (!this.loaded) {
        throw new Error('DingTalk ledger not loaded')
      }
      if (this.readError) {
        throw new Error(`DingTalk ledger unreadable: ${this.readError}`)
      }
      const next = clone(this.state)
      const { result, write } = change(next)
      if (write) {
        await this.persist(next)
        this.state = next
      }
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async read(): Promise<{ state: DingTalkLedgerState; error: string | null }> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
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

  private async persist(state: DingTalkLedgerState): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.filePath)
  }
}
