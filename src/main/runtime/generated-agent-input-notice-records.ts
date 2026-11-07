import { randomUUID } from 'node:crypto'
import {
  GENERATED_INPUT_NOTICE_PAGE_BYTES,
  type GeneratedAgentInputNotice,
  type GeneratedInputNoticesPage
} from '../../shared/generated-agent-input-notice'
import { GeneratedInputNoticeAudiences } from './generated-agent-input-notice-audiences'
import {
  mergeNoticeRegistration,
  newNoticeRecord,
  type GeneratedInputNoticeRecord as NoticeRecord,
  type GeneratedInputNoticeRegistration
} from './generated-agent-input-notice-record'

/** `origin` is the audience: the one logical window a private notice belongs to, or null for a
 *  notice every subscriber of this runtime sees. */
export type GeneratedInputNoticeChange =
  | { kind: 'added'; revision: number; notice: GeneratedAgentInputNotice; origin: string | null }
  | { kind: 'dismissed'; revision: number; id: string; origin: string | null }

/** `discarded`: the operation was explicitly dismissed; nothing of it is kept or to be shown. */
export type GeneratedInputNoticeUpsert = {
  id: string
  retained: boolean
  conflict?: true
  discarded?: true
}

/** These records are the notices, retained for this runtime session until explicit dismissal.
 *  Changes carry only the changed notice; subscribers page the rest, so no message holds them all.
 *  Memory only: nothing here outlives the runtime session. Dismissed ids are kept for the whole
 *  session (one id each, no text) so a late completion or registration never revives one. */
export class GeneratedInputNoticeRecords {
  readonly session = randomUUID()
  private revisionCounter = 0
  protected readonly notices = new Map<string, NoticeRecord>()
  private readonly audiences = new GeneratedInputNoticeAudiences()
  private readonly pendingByOrigin = new Map<string, Set<string>>()
  private readonly dismissed = new Set<string>()
  private readonly listeners = new Set<(change: GeneratedInputNoticeChange) => void>()

  /** Another runtime holds the operation for this one: 'kept' answers a registration of the same
   *  obligation as kept, 'conflict' refuses another one; null when not held elsewhere. */
  protected heldElsewhere(
    _id: string,
    _input: GeneratedInputNoticeRegistration
  ): 'kept' | 'conflict' | null {
    return null
  }

  /** A record became visible, or its registration was applied again. */
  protected settled(_record: NoticeRecord): void {}

  /** A record left this runtime. */
  protected removed(_id: string): void {}

  /** Ids `viewer` must hide, from seek position `from` within `budget` bytes (see page). */
  protected withheldPage(
    _viewer: string,
    _from: number,
    _budget: number
  ): { ids: string[]; next: number | null; bytes: number } {
    return { ids: [], next: null, bytes: 0 }
  }

  get revision(): number {
    return this.revisionCounter
  }

  get pageVisits(): number {
    return this.audiences.pageVisits
  }

  set pageVisits(visits: number) {
    this.audiences.pageVisits = visits
  }

  /** For the count contracts: index rows held and session tombstones. */
  get sizes(): { notices: number; rows: number; dismissed: number } {
    return { notices: this.notices.size, rows: this.audiences.rows, dismissed: this.dismissed.size }
  }

  subscribe(listener: (change: GeneratedInputNoticeChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected publish(record: NoticeRecord): void {
    this.revisionCounter += 1
    const change = {
      kind: 'added' as const,
      revision: this.revisionCounter,
      notice: record.notice,
      origin: record.origin
    }
    for (const listener of this.listeners) {
      listener(change)
    }
  }

  protected publishDismissed(id: string, origin: string | null): void {
    this.revisionCounter += 1
    const change = { kind: 'dismissed' as const, revision: this.revisionCounter, id, origin }
    for (const listener of this.listeners) {
      listener(change)
    }
  }

  /** A detached runtime-owned failure: shared, as before. */
  add(notice: Omit<GeneratedAgentInputNotice, 'id'>): void {
    this.upsert({ ...notice, origin: null, proven: true })
  }

  /** The one write path: creates the operation's record or settles the existing one. The id is
   *  bound to its text, draft/prompt intent, initiating window and target: another obligation
   *  under it is an explicit conflict, never overwrites and is never acknowledged as kept. */
  upsert(input: GeneratedInputNoticeRegistration): GeneratedInputNoticeUpsert {
    const { origin, pending = false } = input
    const id = input.id ?? randomUUID()
    if (this.dismissed.has(id)) {
      return { id, retained: false, discarded: true }
    }
    const elsewhere = this.heldElsewhere(id, input)
    if (elsewhere) {
      return elsewhere === 'kept' ? { id, retained: true } : { id, retained: false, conflict: true }
    }
    const existing = this.notices.get(id)
    if (!existing) {
      const record = newNoticeRecord(id, input)
      this.notices.set(id, record)
      // A host's own operation in flight (no origin) has no audience until it fails or a window
      // claims it.
      if (pending && origin) {
        this.pendingOf(origin).add(id)
      } else if (!pending) {
        this.show(record)
      }
      return { id, retained: true }
    }
    const merged = mergeNoticeRegistration(existing, input)
    if (merged === 'conflict') {
      return { id, retained: false, conflict: true }
    }
    if (merged.claimedPending) {
      this.pendingOf(existing.initiator!).add(id)
    }
    const revealed = existing.pending && !pending
    // A host-established shared failure promotes the same record; it never forks a second one.
    // An unknown agent's notice stays private: older clients require an agent.
    const promoted = origin === null && existing.origin !== null && merged.previous.agent !== null
    if (promoted || revealed) {
      if (existing.pending && existing.origin) {
        this.pendingOf(existing.origin).delete(id)
      }
      this.audiences.unplace(id)
      existing.pending = false
      if (promoted) {
        existing.origin = null
      }
      this.show(existing)
    } else if (merged.changed && this.audiences.isPlaced(id)) {
      this.publish(existing)
    }
    this.settled(existing)
    return { id, retained: true }
  }

  private pendingOf(origin: string): Set<string> {
    let ids = this.pendingByOrigin.get(origin)
    if (!ids) {
      ids = new Set()
      this.pendingByOrigin.set(origin, ids)
    }
    return ids
  }

  private show(record: NoticeRecord): void {
    this.audiences.place(record.notice.id, record.origin, this.revisionCounter + 1)
    this.publish(record)
    this.settled(record)
  }

  // Certainty changes after the fact: published as the same notice with its new metadata.
  private setCertainty(record: NoticeRecord, certainty: GeneratedAgentInputNotice['certainty']) {
    if (record.notice.certainty !== certainty) {
      record.notice = { ...record.notice, certainty }
      if (this.audiences.isPlaced(record.notice.id)) {
        this.publish(record)
      }
    }
  }

  /** A frame of the request was handed to a terminal or its transport: from here it may have
   *  been written, even after an earlier frame was proven refused, and its target is fixed. */
  dispatched(id: string): void {
    const record = this.notices.get(id)
    if (record) {
      record.retargetable = false
      if (!record.proven || record.notice.certainty === 'not-sent') {
        record.proven = false
        this.setCertainty(record, 'unconfirmed')
      }
    }
  }

  /** How a handed-off frame ended. Only a refusal before any frame may have been taken proves the
   *  whole request unsent; a taken or unanswered frame keeps it possibly sent. */
  frameSettled(id: string, settled: 'accepted' | 'refused' | 'unknown'): void {
    const record = this.notices.get(id)
    if (!record) {
      return
    }
    if (settled !== 'refused') {
      record.mayHaveWritten = true
    } else if (!record.mayHaveWritten) {
      this.prove(id, 'not-sent')
    }
  }

  /** The host's own outcome for the request, seen where the request ran or passed back. */
  prove(id: string, certainty: GeneratedAgentInputNotice['certainty'], targetGone = false): void {
    const record = this.notices.get(id)
    if (record) {
      record.proven = true
      record.retargetable = targetGone && certainty === 'not-sent'
      this.setCertainty(record, certainty)
    }
  }

  /** The text a copy command carries, while the operation still holds it. */
  noticeOf(id: string): GeneratedAgentInputNotice | undefined {
    return this.notices.get(id)?.notice
  }

  protected remove(id: string): NoticeRecord | undefined {
    const record = this.notices.get(id)
    if (!record) {
      return undefined
    }
    this.notices.delete(id)
    if (record.pending && record.origin) {
      this.pendingOf(record.origin).delete(id)
    }
    this.audiences.unplace(id)
    this.removed(id)
    return record
  }

  /** The request ended without a failure to keep (delivered, or its owner took it): drop the
   *  pending record of `origin` (any, for the runtime running it). A visible notice is not erased
   *  by a later success. */
  settle(id: string, origin?: string | null): void {
    const record = this.notices.get(id)
    if (record?.pending && (origin === undefined || record.origin === origin)) {
      this.remove(id)
    }
  }

  /** Whether `id` is an operation this window started, so one of its frames may settle it. */
  belongsTo(id: string, origin: string): boolean {
    return this.notices.get(id)?.initiator === origin
  }

  /** Whether the record is still waiting for its request's outcome, unseen. */
  isPending(id: string): boolean {
    return this.notices.get(id)?.pending === true
  }

  /** A window's renderer was replaced while its requests were pending: each becomes a notice of
   *  uncertain delivery, since nobody is left to read its answer. Only that window's are read. */
  revealPending(origin: string, connection: string | undefined): void {
    for (const id of this.pendingOf(origin)) {
      const record = this.notices.get(id)!
      if (record.connection !== connection) {
        // Its own certainty: text still waiting for a terminal was never written.
        this.upsert({ ...record.notice, origin })
      }
    }
  }

  recovery(
    notice: Omit<GeneratedAgentInputNotice, 'id' | 'certainty'>
  ): (certainty: GeneratedAgentInputNotice['certainty']) => void {
    let recovered = false
    return (certainty) => {
      if (recovered) {
        return
      }
      recovered = true
      this.add({ ...notice, certainty })
    }
  }

  /** Whether `viewer` may see (and so dismiss) this record. */
  visibleTo(id: string, viewer: string | null): boolean {
    const record = this.notices.get(id)
    return !!record && !record.pending && (record.origin === null || record.origin === viewer)
  }

  /** Explicit discard: by a viewer of the notice (or the window holding it pending), or for an
   *  operation not recorded yet, so a late completion or registration stays discarded. Null when
   *  this viewer may not discard it; else the discarded record, if there was one. */
  protected discard(id: string, viewer: string | null): { record?: NoticeRecord } | null {
    const record = this.notices.get(id)
    if (
      record &&
      !this.visibleTo(id, viewer) &&
      !(record.pending && (record.initiator === null || record.initiator === viewer))
    ) {
      return null
    }
    this.dismissed.add(id)
    const removed = this.remove(id)
    if (removed && !removed.pending) {
      this.publishDismissed(id, removed.origin)
    }
    return removed ? { record: removed } : {}
  }

  /** One bounded snapshot page for `viewer`, from the notice added at `cursor` (or the next one)
   *  at `offset`: shared notices and the viewer's own, merged in add order. A window's snapshot
   *  first lists, from cursor 0 and its own seek `offset`, the discards its hosts have not applied
   *  yet, so their copies stay hidden meanwhile; notices start once those are all sent. */
  page(cursor = 0, offset = 0, viewer: string | null = null): GeneratedInputNoticesPage {
    const page: GeneratedInputNoticesPage = {
      session: this.session,
      revision: this.revisionCounter,
      frames: [],
      next: null
    }
    const noticeOf = (id: string) => this.notices.get(id)!.notice
    if (!viewer || cursor !== 0) {
      return this.audiences.fillPage(page, noticeOf, cursor, offset, viewer, 0)
    }
    const withheld = this.withheldPage(viewer, offset, GENERATED_INPUT_NOTICE_PAGE_BYTES)
    if (withheld.ids.length) {
      page.withheld = withheld.ids
    }
    if (withheld.next !== null) {
      page.next = { cursor: 0, offset: withheld.next }
      return page
    }
    return this.audiences.fillPage(page, noticeOf, 0, 0, viewer, withheld.bytes)
  }
}
