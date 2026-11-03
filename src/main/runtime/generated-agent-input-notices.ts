import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from './orca-runtime'
import {
  GENERATED_INPUT_NOTICE_PAGE_BYTES,
  generatedInputNoticeFrames,
  type GeneratedAgentInputNotice,
  type GeneratedInputNoticesPage
} from '../../shared/generated-agent-input-notice'

/** `origin` is the audience: the one logical window a private notice belongs to, or null for a
 *  notice every subscriber of this runtime sees. */
export type GeneratedInputNoticeChange =
  | { kind: 'added'; revision: number; notice: GeneratedAgentInputNotice; origin: string | null }
  | { kind: 'dismissed'; revision: number; id: string; origin: string | null }

/** One failed request's notice: its operation id is the notice id, so a send's own failure, a
 *  recovery registration and a reload all land on this one record. */
export type GeneratedInputNoticeRegistration = Omit<GeneratedAgentInputNotice, 'id'> & {
  id?: string
  /** The window that owns a private notice; null keeps today's shared audience. */
  origin: string | null
  /** Held before dispatch so a reload mid-request loses nothing; never shown while pending. */
  pending?: boolean
  /** The connection that installed a pending record; another connection of the same window
   *  re-subscribing means that renderer was replaced, so the record becomes a notice. */
  connection?: string
  /** The runtime holding the authoritative record when this one projects it (a remote host). */
  owner?: string
  /** The owner established the outcome itself (its operation ran); a client's inference never
   *  overrides that. */
  proven?: boolean
}

type NoticeRecord = {
  notice: GeneratedAgentInputNotice
  added: number
  origin: string | null
  pending: boolean
  connection?: string
  owner?: string
}

/** These records are the notices, retained for this runtime session until explicit dismissal.
 *  Changes carry only the changed notice; subscribers page the rest, so no message holds them all.
 *  Memory only: nothing here outlives the runtime session. */
export class GeneratedAgentInputNotices {
  readonly session = randomUUID()
  private revisionCounter = 0
  // Insertion order is add order; each notice keeps the revision that added it as its page cursor.
  private readonly notices = new Map<string, NoticeRecord>()
  // Add order as a seekable index: a page binary-searches its cursor instead of rescanning.
  private order: { added: number; id: string }[] = []
  // Dismissed operations, until runtime end: a late completion or registration cannot revive them.
  private readonly dismissed = new Set<string>()
  private readonly listeners = new Set<(change: GeneratedInputNoticeChange) => void>()
  /** Records a page touched, for the operation-count contract (linear in what was sent). */
  pageVisits = 0

  get revision(): number {
    return this.revisionCounter
  }

  subscribe(listener: (change: GeneratedInputNoticeChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(change: GeneratedInputNoticeChange): void {
    for (const listener of this.listeners) {
      listener(change)
    }
  }

  /** A detached runtime-owned failure: shared, as before. */
  add(notice: Omit<GeneratedAgentInputNotice, 'id'>): void {
    this.upsert({ ...notice, origin: null, proven: true })
  }

  /** The one write path: creates the operation's record or settles the existing one. Text is
   *  fixed by the first write; a dismissed operation stays dismissed. */
  upsert(input: GeneratedInputNoticeRegistration): { id: string; retained: boolean } {
    const { origin, pending = false, connection, owner, proven, id: given, ...fields } = input
    const id = given ?? randomUUID()
    if (this.dismissed.has(id)) {
      return { id, retained: false }
    }
    const existing = this.notices.get(id)
    if (!existing) {
      this.revisionCounter += 1
      const record: NoticeRecord = {
        notice: { ...fields, id },
        added: this.revisionCounter,
        origin,
        pending,
        ...(connection ? { connection } : {}),
        ...(owner ? { owner } : {})
      }
      this.notices.set(id, record)
      this.order.push({ added: this.revisionCounter, id })
      if (!pending) {
        this.publish({
          kind: 'added',
          revision: this.revisionCounter,
          notice: record.notice,
          origin
        })
      }
      return { id, retained: true }
    }
    // Another request's text under this id would be a conflict: the original text is kept.
    if (existing.notice.text !== fields.text) {
      return { id, retained: true }
    }
    const revealed = existing.pending && !pending
    // The owner's own outcome, or the first real one for a placeholder, sets the certainty.
    if (proven || revealed) {
      existing.notice = { ...existing.notice, certainty: fields.certainty }
    }
    // A host-established shared failure promotes the same record; it never forks a second one.
    // An unknown agent's notice stays private: older clients require an agent.
    const promoted = origin === null && existing.origin !== null && existing.notice.agent !== null
    if (promoted) {
      existing.origin = null
    }
    if (revealed) {
      existing.pending = false
      existing.owner = owner
    }
    if (promoted || revealed) {
      this.revisionCounter += 1
      this.publish({
        kind: 'added',
        revision: this.revisionCounter,
        notice: existing.notice,
        origin: existing.origin
      })
    }
    return { id, retained: true }
  }

  /** The request ended without a failure to keep (delivered, or its owner took it): drop the
   *  pending record. A visible notice is not erased by a later success. */
  settle(id: string, origin: string | null): void {
    const record = this.notices.get(id)
    if (record?.pending && record.origin === origin) {
      this.notices.delete(id)
    }
  }

  /** A window's renderer was replaced while its requests were pending: each becomes a notice of
   *  uncertain delivery, since nobody is left to read its answer. */
  revealPending(origin: string, connection: string | undefined): void {
    for (const record of this.notices.values()) {
      if (record.pending && record.origin === origin && record.connection !== connection) {
        this.upsert({ ...record.notice, certainty: 'unconfirmed', origin, owner: record.owner })
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

  /** Explicit discard: by a viewer of the notice, or for an operation not recorded yet (a
   *  late completion or registration then stays discarded). */
  dismiss(id: string, viewer: string | null = null): void {
    const record = this.notices.get(id)
    if (record && !this.visibleTo(id, viewer) && !(record.pending && record.origin === viewer)) {
      return
    }
    this.dismissed.add(id)
    if (record && this.notices.delete(id)) {
      // Compact once dismissed entries outnumber live ones, so the index stays linear in notices.
      if (this.order.length > 2 * this.notices.size + 16) {
        this.order = this.order.filter((entry) => this.notices.has(entry.id))
      }
      if (!record.pending) {
        this.revisionCounter += 1
        this.publish({
          kind: 'dismissed',
          revision: this.revisionCounter,
          id,
          origin: record.origin
        })
      }
    }
  }

  /** One bounded snapshot page for `viewer`, from the notice added at `cursor` (or the next one)
   *  at `offset`. Private and pending records are filtered before any frame is built. */
  page(cursor = 0, offset = 0, viewer: string | null = null): GeneratedInputNoticesPage {
    const page: GeneratedInputNoticesPage = {
      session: this.session,
      revision: this.revisionCounter,
      frames: [],
      next: null
    }
    let low = 0
    let high = this.order.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (this.order[mid].added < cursor) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    let spent = 0
    for (let index = low; index < this.order.length; index += 1) {
      const { added, id } = this.order[index]
      this.pageVisits += 1
      if (!this.visibleTo(id, viewer)) {
        continue
      }
      const record = this.notices.get(id)!
      // A notice dismissed between pages restarts its successor from the beginning.
      const from = added === cursor ? offset : 0
      const { frames, next, bytes } = generatedInputNoticeFrames(
        record.notice,
        from,
        GENERATED_INPUT_NOTICE_PAGE_BYTES - spent
      )
      page.frames.push(...frames)
      spent += bytes
      if (next !== null) {
        // The first notice of a page always fits its metadata, so every page makes progress.
        page.next = { cursor: added, offset: next }
        return page
      }
    }
    return page
  }
}

export function captureGeneratedInputRecovery(
  runtime: Pick<
    OrcaRuntimeService,
    'generatedInputNotices' | 'getTerminalPtyIdForHandle' | 'getTerminalWorktreeIdForHandle'
  >,
  handle: string,
  agent: GeneratedAgentInputNotice['agent'],
  text: string,
  submitted = true
): (certainty: GeneratedAgentInputNotice['certainty']) => void {
  return runtime.generatedInputNotices.recovery({
    handle,
    agent,
    text,
    ...(submitted ? {} : { submitted: false }),
    ptyId: runtime.getTerminalPtyIdForHandle(handle),
    worktreeId: runtime.getTerminalWorktreeIdForHandle(handle) ?? ''
  })
}
