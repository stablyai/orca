// One IM-started turn's reply message, from first sight to final answer, for a platform that keeps
// its reply state as one record per turn: a card opened at once, edited with progress as the turn
// runs, then the answer in it and in continuation messages. A card that can't open falls back to
// one progress notice and the answer as messages. The record lets a restart finish the answer
// under the platform's delivery guarantee.
import { ImLiveStream, type ImStreamDegrade } from './im-stream-live'
import { sendImParts, type ImDeliveryGuarantee } from './im-stream-part-delivery'
import { splitImText, type ImPartLabel, type ImTextLimit } from './im-stream-parts'
import { renderImProgress, type ImProgressFormat } from './im-stream-progress'
import type { ImTurnView } from './im-stream-turn-view'

export type ImStreamRecord = {
  /** opening: a card was asked for and no answer kept, so one may exist that this never edits. */
  state: 'opening' | 'open' | 'fallback' | 'finishing' | 'done'
  handle?: string
  /** Why the stream shows no live progress. */
  error?: string
  noticeSent?: true
  /** How many of the final parts settled, in order. */
  partsSent?: number
  /** A part handed over whose outcome was never written. */
  partSending?: number
  /** Parts that may not have shown, under at-most-once; for the platform to offer a resend. */
  unconfirmed?: number[]
  /** The card refused the final; its first part went as a message instead. */
  cardRefused?: true
  updatedAt: number
}

export type ImStreamPhase = 'progress' | 'done' | 'failed'

export type ImStreamPort = {
  /** Opens the reply card showing `placeholder`; its handle. Throws when no card was made. Absent
   *  when the reply goes as plain messages only. */
  open?(placeholder: string): Promise<string>
  /** Replaces the card's content; repeating one never shows it twice. */
  update(handle: string, content: string, phase: ImStreamPhase): Promise<void>
  /** A plain message under a key stable for it. */
  send(text: string, key: string): Promise<void>
  /** What a resend of `send` under the same key does. */
  guarantee: ImDeliveryGuarantee
  /** At most once: whether a failed send may have shown anyway. */
  unknown?: (error: unknown) => boolean
}

export type ImStreamStore = {
  read(): ImStreamRecord | undefined
  write(record: ImStreamRecord): Promise<void>
}

export type ImReplyCopy = {
  /** What a new card shows before the turn has anything to show. */
  placeholder: string
  /** The one message a turn sends before its answer when it has no card to edit. */
  notice: string
  progress: ImProgressFormat
  part: ImPartLabel
}

export type ImReplyStreamDeps = {
  port: ImStreamPort
  store: ImStreamStore
  /** Stable for the turn; part keys derive from it. */
  key: string
  limit: ImTextLimit
  copy: ImReplyCopy
  /** The stream lost live progress, and why; for the connector's status. */
  onDegraded: (reason: string) => void
  /** What a failed progress edit means; absent: the first failure stops live progress. */
  classify?: (error: unknown) => ImStreamDegrade | null
  gapMs?: number
}

const reasonOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200) || 'unknown error'

export class ImReplyStream {
  private live: ImLiveStream | null = null
  private begun: Promise<void> | null = null
  private finishing: Promise<number[]> | null = null

  constructor(private readonly deps: ImReplyStreamDeps) {}

  /** Opens the card, or picks up what a restart left; once per stream. */
  begin(): Promise<void> {
    this.begun ??= this.open(true)
    return this.begun
  }

  /** The turn as it stands now; edits the card at the stream's pace. */
  progress(view: ImTurnView): void {
    this.live?.update(view)
  }

  /** Plain interim text in place of progress, at the same pace. */
  note(text: string): void {
    this.live?.note(text)
  }

  /** The answer, delivered once even across restarts (at most once: parts that may not have shown
   *  are returned). Throws when a part was not taken; a later call resumes from that part. */
  finish(answer: string, phase: Exclude<ImStreamPhase, 'progress'> = 'done'): Promise<number[]> {
    this.finishing ??= this.deliver(answer, phase).finally(() => {
      this.finishing = null
    })
    return this.finishing
  }

  /** Stops interim edits without finishing; the record stays for a later finish. */
  async close(): Promise<void> {
    await this.live?.close()
    this.live = null
  }

  private async write(patch: Partial<ImStreamRecord>): Promise<ImStreamRecord> {
    // The first write of every stream names its state, so the default never shows.
    const record: ImStreamRecord = {
      state: 'opening',
      ...this.deps.store.read(),
      ...patch,
      updatedAt: Date.now()
    }
    await this.deps.store.write(record)
    return record
  }

  private follow(handle: string, shown?: string): void {
    const { port, copy } = this.deps
    this.live = new ImLiveStream({
      write: (content) => port.update(handle, content, 'progress'),
      render: (view) => renderImProgress(view, copy.progress),
      ...(this.deps.classify ? { classify: this.deps.classify } : { failuresBeforeDegrade: 1 }),
      ...(shown === undefined ? {} : { shown }),
      ...(this.deps.gapMs === undefined ? {} : { gapMs: this.deps.gapMs }),
      onDegraded: (reason, error) =>
        this.deps.onDegraded(`progress edit failed (${reason}): ${reasonOf(error)}`)
    })
  }

  /** notice: whether a fallback tells the asker the answer is coming; not when it is here. */
  private async open(notice: boolean): Promise<void> {
    const kept = this.deps.store.read()
    if (kept) {
      if (kept.state === 'open' && kept.handle) {
        this.follow(kept.handle)
      }
      return
    }
    const { port, copy, key } = this.deps
    const openCard = port.open?.bind(port)
    if (!openCard) {
      await this.write({ state: 'fallback' })
      return
    }
    await this.write({ state: 'opening' })
    let handle: string
    try {
      handle = await openCard(copy.placeholder)
    } catch (error) {
      const reason = reasonOf(error)
      await this.write({ state: 'fallback', error: reason })
      this.deps.onDegraded(`reply card unavailable: ${reason}`)
      if (!notice) {
        return
      }
      try {
        await port.send(copy.notice, `${key}:notice`)
        await this.write({ noticeSent: true })
      } catch {
        // The answer still goes; the notice only tells the asker it is coming.
      }
      return
    }
    await this.write({ state: 'open', handle })
    this.follow(handle, copy.placeholder)
  }

  private async deliver(answer: string, phase: 'done' | 'failed'): Promise<number[]> {
    // A turn that ends at once still opens its card first, so the answer lands in it.
    this.begun ??= this.open(false)
    await this.begun.catch(() => {})
    await this.close()
    const kept = this.deps.store.read()
    if (kept?.state === 'done') {
      return kept.unconfirmed ?? []
    }
    const { port, key } = this.deps
    const parts = splitImText(answer, this.deps.limit, this.deps.copy.part)
    let record = await this.write({ state: 'finishing', partsSent: kept?.partsSent ?? 0 })
    if (record.partsSent === 0 && record.handle && !record.cardRefused) {
      // An edit replaces the card's content, so repeating one never shows the answer twice.
      record = await this.write(
        (await this.finalEdit(record.handle, parts[0]!, phase))
          ? { partsSent: 1 }
          : { cardRefused: true }
      )
    }
    const unconfirmed = [...(record.unconfirmed ?? [])]
    await sendImParts(
      parts,
      { sent: record.partsSent ?? 0, sending: record.partSending ?? null },
      {
        guarantee: port.guarantee,
        send: (text, index) => port.send(text, `${key}:part:${index}`),
        ...(port.unknown ? { unknown: port.unknown } : {})
      },
      {
        sending: async (index) => {
          await this.write({ partSending: index })
        },
        settled: async (index, shown) => {
          if (!shown) {
            unconfirmed.push(index)
          }
          await this.write({ partsSent: index + 1, partSending: undefined, unconfirmed })
        },
        refused: async () => {
          await this.write({ partSending: undefined })
        }
      }
    )
    await this.write({ state: 'done' })
    return unconfirmed
  }

  private async finalEdit(
    handle: string,
    part: string,
    phase: 'done' | 'failed'
  ): Promise<boolean> {
    let failure: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.deps.port.update(handle, part, phase)
        return true
      } catch (error) {
        failure = error
      }
    }
    this.deps.onDegraded(`final card edit failed: ${reasonOf(failure)}`)
    return false
  }
}
