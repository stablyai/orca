import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from './orca-runtime'
import {
  GENERATED_INPUT_NOTICE_PAGE_BYTES,
  generatedInputNoticeFrames,
  type GeneratedAgentInputNotice,
  type GeneratedInputNoticesPage
} from '../../shared/generated-agent-input-notice'

export type GeneratedInputNoticeChange =
  | { kind: 'added'; revision: number; notice: GeneratedAgentInputNotice }
  | { kind: 'dismissed'; revision: number; id: string }

/** These records are the notices, retained for this runtime session until explicit dismissal.
 *  Changes carry only the changed notice; subscribers page the rest, so no message holds them all. */
export class GeneratedAgentInputNotices {
  readonly session = randomUUID()
  private revisionCounter = 0
  // Insertion order is add order; each notice keeps the revision that added it as its page cursor.
  private readonly notices = new Map<string, { notice: GeneratedAgentInputNotice; added: number }>()
  // Add order as a seekable index: a page binary-searches its cursor instead of rescanning.
  private order: { added: number; id: string }[] = []
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

  add(notice: Omit<GeneratedAgentInputNotice, 'id'>): void {
    const record = { ...notice, id: randomUUID() }
    this.revisionCounter += 1
    this.notices.set(record.id, { notice: record, added: this.revisionCounter })
    this.order.push({ added: this.revisionCounter, id: record.id })
    this.publish({ kind: 'added', revision: this.revisionCounter, notice: record })
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

  dismiss(id: string): void {
    if (this.notices.delete(id)) {
      // Compact once dismissed entries outnumber live ones, so the index stays linear in notices.
      if (this.order.length > 2 * this.notices.size + 16) {
        this.order = this.order.filter((entry) => this.notices.has(entry.id))
      }
      this.revisionCounter += 1
      this.publish({ kind: 'dismissed', revision: this.revisionCounter, id })
    }
  }

  /** One bounded snapshot page from the notice added at `cursor` (or the next one), at `offset`. */
  page(cursor = 0, offset = 0): GeneratedInputNoticesPage {
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
      const record = this.notices.get(id)
      this.pageVisits += 1
      if (!record) {
        continue
      }
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
