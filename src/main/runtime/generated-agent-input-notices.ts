import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from './orca-runtime'
import {
  GENERATED_INPUT_NOTICE_PAGE_UNITS,
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
  private readonly listeners = new Set<(change: GeneratedInputNoticeChange) => void>()

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
    let spent = 0
    for (const { notice, added } of this.notices.values()) {
      if (added < cursor) {
        continue
      }
      // A notice dismissed between pages restarts its successor from the beginning.
      const from = added === cursor ? offset : 0
      const { frames, next } = generatedInputNoticeFrames(
        notice,
        from,
        GENERATED_INPUT_NOTICE_PAGE_UNITS - spent
      )
      page.frames.push(...frames)
      spent += frames.reduce((units, frame) => units + frame.chunk.length, 0)
      if (next !== null) {
        page.next = { cursor: added, offset: next }
        return page
      }
      if (spent >= GENERATED_INPUT_NOTICE_PAGE_UNITS) {
        page.next = { cursor: added + 1, offset: 0 }
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
  text: string
): (certainty: GeneratedAgentInputNotice['certainty']) => void {
  return runtime.generatedInputNotices.recovery({
    handle,
    agent,
    text,
    ptyId: runtime.getTerminalPtyIdForHandle(handle),
    worktreeId: runtime.getTerminalWorktreeIdForHandle(handle) ?? ''
  })
}
