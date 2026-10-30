import type Database from '../../sqlite/sync-database'
import {
  MailOriginalLocator,
  originalReference as pair,
  originalCoordinate as coordinate
} from './structured-mail-original-locator'
import { commandReceiptSchema } from '../../native-chat/agent-session-journal/command-receipt-schema'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  conversationRecordReader,
  resolveLineageRunningSession
} from './structured-session-lineage'
import {
  observeMailHistoryChanges,
  flushMailHistoryChanges,
  disposeMailHistoryChanges,
  cancelMailHistoryRetry,
  type MailHistoryChange
} from './structured-mail-history-revision'
export type MailCreationHistory = { members: ReadonlySet<string>; opaque: boolean }
export { mailMemberKey } from './structured-mail-original-locator'
type Evidence = { sessionId: string; operationId: string; refs: string[]; members: Set<string> }
const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((k) => b.has(k))

/** One cold original locator per DB generation; hot changes visit only actual references. */
class OriginalMailHistory {
  private readonly locator = new MailOriginalLocator()
  private readonly originals = this.locator.originals
  private readonly drafts = this.locator.drafts
  private readonly evidence = new Map<string, Evidence>()
  private readonly references = new Map<string, Set<string>>()
  private readonly sessions = new Map<string, Set<string>>()
  private readonly roots = new Map<string, Set<string>>()
  private readonly lineages = new Map<string, readonly string[]>()
  private readonly counts = new Map<string, number>()
  private readonly members = new Set<string>()
  private readonly wake = new Set<string>()
  private readonly listeners = new Set<(members: ReadonlySet<string>) => void>()
  private initialized = false
  private stopCapture: (() => void) | undefined
  private readonly db: Database.Database
  constructor(private readonly host: StructuredAgentSessionHost) {
    this.db = host.deps.journalDatabase.db
    host.deps.journalDatabase.onClose(() => this.dispose())
  }
  private initialize(): void {
    if (this.initialized) {
      return
    }
    if (!this.host.deps.journalDatabase.readOnly) {
      this.stopCapture = observeMailHistoryChanges(this.db, this.changed)
    }
    // Capture precedes this synchronous committed census; no producer can interleave an await.
    for (const row of this.db
      .prepare(
        'SELECT session_id, epoch, seq, row_json FROM journal_rows ORDER BY session_id, epoch, seq'
      )
      .iterate()) {
      if (
        typeof row.session_id === 'string' &&
        typeof row.epoch === 'string' &&
        typeof row.seq === 'number'
      ) {
        this.locator.readOriginal(row.session_id, coordinate(row.epoch, row.seq), row.row_json)
      }
    }
    for (const row of this.db
      .prepare(`SELECT DISTINCT session_id, operation_id FROM agent_session_command_receipts
      WHERE caller_key LIKE 'trusted-local:orchestration:%' AND method = 'agentSession.send'`)
      .iterate()) {
      if (typeof row.session_id === 'string' && typeof row.operation_id === 'string') {
        this.updateOperation(row.session_id, row.operation_id)
      }
    }
    this.initialized = true
    flushMailHistoryChanges(this.db)
    this.wake.clear()
  }
  private here(session: string): boolean {
    for (const id of this.lineages.get(session) ?? []) {
      this.roots.get(id)?.delete(session)
    }
    const lineage = resolveLineageRunningSession(
      conversationRecordReader(this.host.deps.store),
      session
    )
    this.lineages.set(session, lineage.lineage)
    for (const id of lineage.lineage) {
      const roots = this.roots.get(id) ?? new Set<string>()
      roots.add(session)
      this.roots.set(id, roots)
    }
    return lineage.kind === 'here'
  }
  private updateOperation(sessionId: string, operationId: string): void {
    const key = pair(sessionId, operationId)
    const prior = this.evidence.get(key)
    const refs = new Set<string>()
    const members = new Set<string>()
    const rows = this.db
      .prepare(`SELECT caller_key FROM agent_session_command_receipts
      WHERE operation_id = ? AND session_id = ? AND method = 'agentSession.send'
      AND caller_key LIKE 'trusted-local:orchestration:%'`)
      .all(operationId, sessionId)
    const local = rows.length ? this.here(sessionId) : false
    for (const row of rows) {
      if (typeof row.caller_key !== 'string') {
        continue
      }
      const read = this.host.deps.store.readCommandReceipt(
        { kind: 'caller', callerKey: row.caller_key },
        operationId
      )
      if (read.verdict !== 'readable') {
        continue
      }
      const validated = commandReceiptSchema.safeParse(read.receipt)
      if (!validated.success || validated.data.status !== 'accepted') {
        continue
      }
      const result = validated.data.result
      const reference =
        result.kind === 'queued-draft'
          ? pair(sessionId, result.messageId)
          : result.kind === 'journal-row'
            ? pair(sessionId, coordinate(result.epoch, result.sequence))
            : null
      if (!reference) {
        continue
      }
      refs.add(reference)
      const candidates = result.kind === 'queued-draft' ? this.drafts.get(reference) : [reference]
      for (const candidate of candidates ?? []) {
        if (local) {
          for (const member of this.originals.get(candidate)?.members ?? []) {
            members.add(member)
          }
        }
      }
    }
    // The selected evidence is small; an unrelated task never copies the retained member population.
    if (prior && same(prior.members, members) && same(new Set(prior.refs), refs)) {
      return
    }
    for (const ref of prior?.refs ?? []) {
      const operations = this.references.get(ref)
      operations?.delete(key)
      if (!operations?.size) {
        this.references.delete(ref)
      }
    }
    for (const ref of refs) {
      const operations = this.references.get(ref) ?? new Set<string>()
      operations.add(key)
      this.references.set(ref, operations)
    }
    for (const member of prior?.members ?? []) {
      if (!members.has(member)) {
        const count = (this.counts.get(member) ?? 1) - 1
        if (count) {
          this.counts.set(member, count)
        } else {
          this.counts.delete(member)
          this.members.delete(member)
        }
        this.wake.add(member)
      }
    }
    for (const member of members) {
      if (!prior?.members.has(member)) {
        this.counts.set(member, (this.counts.get(member) ?? 0) + 1)
        this.members.add(member)
        this.wake.add(member)
      }
    }
    const operations = this.sessions.get(sessionId) ?? new Set<string>()
    if (rows.length) {
      operations.add(key)
      this.sessions.set(sessionId, operations)
      this.evidence.set(key, { sessionId, operationId, refs: [...refs], members })
    } else {
      operations.delete(key)
      this.evidence.delete(key)
      if (!operations.size) {
        this.sessions.delete(sessionId)
        for (const id of this.lineages.get(sessionId) ?? []) {
          const roots = this.roots.get(id)
          roots?.delete(sessionId)
          if (!roots?.size) {
            this.roots.delete(id)
          }
        }
        this.lineages.delete(sessionId)
      }
    }
  }
  private readonly changed = (changes: readonly MailHistoryChange[]): void => {
    const selected = new Map<string, { sessionId: string; operationId: string }>()
    const nominate = (key: string) => {
      const value = this.evidence.get(key)
      if (value) {
        selected.set(key, value)
      }
    }
    for (const change of changes) {
      if (change.kind === 'receipt') {
        selected.set(pair(change.sessionId, change.key), {
          sessionId: change.sessionId,
          operationId: change.key
        })
      } else if (change.kind === 'row') {
        const key = pair(change.sessionId, change.key)
        const old = this.originals.get(key)
        for (const id of this.references.get(key) ?? []) {
          nominate(id)
        }
        for (const id of old?.draft ? (this.references.get(old.draft) ?? []) : []) {
          nominate(id)
        }
        const [epoch, seq]: unknown[] = JSON.parse(change.key)
        if (typeof epoch !== 'string' || typeof seq !== 'number') {
          continue
        }
        const row = this.db
          .prepare(
            'SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?'
          )
          .get(change.sessionId, epoch, seq)
        this.locator.readOriginal(change.sessionId, change.key, row?.row_json)
        const next = this.originals.get(key)
        for (const id of next?.draft ? (this.references.get(next.draft) ?? []) : []) {
          nominate(id)
        }
      } else {
        const roots = new Set([change.sessionId, ...(this.roots.get(change.sessionId) ?? [])])
        for (const root of roots) {
          for (const key of this.sessions.get(root) ?? []) {
            nominate(key)
          }
        }
      }
    }
    for (const op of selected.values()) {
      this.updateOperation(op.sessionId, op.operationId)
    }
    for (const listener of this.listeners) {
      listener(this.wake)
    }
    this.wake.clear()
  }
  read(): MailCreationHistory {
    this.initialize()
    flushMailHistoryChanges(this.db)
    return { members: this.members, opaque: true }
  }
  observe(listener: (members: ReadonlySet<string>) => void): () => void {
    this.initialize()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        cancelMailHistoryRetry(this.db)
      }
    }
  }
  private dispose(): void {
    this.stopCapture?.()
    disposeMailHistoryChanges(this.db)
    for (const map of [
      this.originals,
      this.drafts,
      this.evidence,
      this.references,
      this.sessions,
      this.roots,
      this.lineages,
      this.counts
    ]) {
      map.clear()
    }
    this.members.clear()
    this.wake.clear()
    this.listeners.clear()
    this.initialized = false
    histories.delete(this.db)
  }
}
const histories = new WeakMap<Database.Database, OriginalMailHistory>()
export function originalMailHistory(host: StructuredAgentSessionHost): OriginalMailHistory {
  const db = host.deps.journalDatabase.db
  let history = histories.get(db)
  if (!history) {
    history = new OriginalMailHistory(host)
    histories.set(db, history)
  }
  return history
}
