import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as z from 'zod'
import type {
  ConversationRow,
  DingTalkLedgerState,
  InboxRow,
  InboxState,
  ReplyRow,
  ReplyState
} from './dingtalk-domain'

const Ledger = z.object({
  version: z.literal(1),
  inbox: z.record(z.string(), z.unknown()),
  conversations: z.record(z.string(), z.unknown()),
  replies: z.record(z.string(), z.unknown()),
  watermarks: z.record(z.string(), z.string())
})

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

  constructor(private readonly filePath: string) {
    this.state = this.read()
  }

  snapshot(): LedgerSnapshot {
    return clone(this.state)
  }

  putInbox(row: InboxRow): boolean {
    if (this.state.inbox[row.key]) {
      return false
    }
    this.state.inbox[row.key] = row
    this.persist()
    return true
  }

  putConversation(row: ConversationRow): void {
    this.state.conversations[row.externalId] = row
    this.persist()
  }

  putReply(row: ReplyRow): boolean {
    if (this.state.replies[row.key]) {
      return false
    }
    this.state.replies[row.key] = row
    this.persist()
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
    this.state.inbox[key] = updated
    this.persist()
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
    this.state.replies[key] = updated
    this.persist()
    return updated
  }

  setWatermark(key: string, value: string): void {
    this.state.watermarks[key] = value
    this.persist()
  }

  private read(): DingTalkLedgerState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const envelope = Ledger.parse(parsed)
      return {
        version: 1,
        inbox: Object.fromEntries(
          Object.entries(envelope.inbox).flatMap(([key, value]) =>
            isInbox(value) ? [[key, value]] : []
          )
        ),
        conversations: Object.fromEntries(
          Object.entries(envelope.conversations).flatMap(([key, value]) =>
            isConversation(value) ? [[key, value]] : []
          )
        ),
        replies: Object.fromEntries(
          Object.entries(envelope.replies).flatMap(([key, value]) =>
            isReply(value) ? [[key, value]] : []
          )
        ),
        watermarks: envelope.watermarks
      }
    } catch {
      return empty()
    }
  }

  private persist(): void {
    if (this.writing) {
      throw new Error('DingTalk ledger write re-entry')
    }
    this.writing = true
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      chmodSync(dirname(this.filePath), 0o700)
      const temporary = `${this.filePath}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.filePath)
    } finally {
      this.writing = false
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function isInbox(value: unknown): value is InboxRow {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.state === 'string' &&
    typeof value.externalId === 'string'
  )
}
function isConversation(value: unknown): value is ConversationRow {
  return (
    isRecord(value) &&
    typeof value.externalId === 'string' &&
    typeof value.botId === 'string' &&
    typeof value.sessionId === 'string'
  )
}
function isReply(value: unknown): value is ReplyRow {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.externalId === 'string' &&
    typeof value.uuid === 'string' &&
    typeof value.state === 'string'
  )
}
