import type { JournalRow } from './journal-row-schema'
import { journalTextFields, type JournalSequenceRange } from './journal-text-rows'

type Range = { first: number; last: number; next: Range | null }
export type JournalTextPieces = {
  itemId: string
  field: number
  marker: { seq: number; revision: number } | null
  witness: { seq: number; revision: number; settlementId?: string } | null
  revision: number
  head: Range | null
  tail: Range | null
  released: Set<number>
}
export const journalTextKey = (itemId: string, field: number): string =>
  JSON.stringify([itemId, field])

/** Derived positions only; unexamined ranges advance once, protected exceptions wake by key. */
export class JournalTextIndex {
  readonly pieces = new Map<string, JournalTextPieces>()
  readonly ready = new Set<string>()
  private readonly protectedRows = new Map<number, number>()
  private readonly parked = new Map<number, string>()
  /** Physical format boundary; the prefix through this retained whole stays strict. */
  sparseAfter: number | null = null
  protectionMoved(previous: number | undefined, next: number): void {
    if (previous === next) {
      return
    }
    if (previous !== undefined) {
      const count = (this.protectedRows.get(previous) ?? 1) - 1
      if (count) {
        this.protectedRows.set(previous, count)
      } else {
        this.protectedRows.delete(previous)
        const key = this.parked.get(previous)
        if (key !== undefined) {
          this.parked.delete(previous)
          this.pieces.get(key)?.released.add(previous)
          this.ready.add(key)
        }
      }
    }
    this.protectedRows.set(next, (this.protectedRows.get(next) ?? 0) + 1)
  }
  isProtected(seq: number): boolean {
    return this.protectedRows.has(seq)
  }
  private reconsider(key: string, piece: JournalTextPieces): void {
    if (piece.released.size || (piece.head && piece.head.first < (piece.witness?.seq ?? 0))) {
      this.ready.add(key)
    } else {
      this.ready.delete(key)
    }
  }
  unwitnessed(itemId: string, field: number): boolean {
    const piece = this.pieces.get(journalTextKey(itemId, field))
    return (
      piece?.tail !== null &&
      piece?.tail !== undefined &&
      piece.tail.last > (piece.witness?.seq ?? 0)
    )
  }
  delta(row: Extract<JournalRow, { kind: 'text-delta' }>): void {
    const key = journalTextKey(row.itemId, row.field)
    const piece = this.pieces.get(key)
    if (!piece?.marker) {
      throw new Error('journal_text_anchor_missing')
    }
    if (piece.tail && piece.tail.last + 1 === row.seq) {
      piece.tail.last = row.seq
    } else {
      const range: Range = { first: row.seq, last: row.seq, next: null }
      if (piece.tail) {
        piece.tail.next = range
      } else {
        piece.head = range
      }
      piece.tail = range
    }
    this.reconsider(key, piece)
  }
  /** Called only after the ordinary item fold actually accepts this whole. */
  whole(
    row: JournalRow,
    itemId: string,
    revision: number,
    body: Extract<JournalRow, { kind: 'item' }>['body']
  ): void {
    const fields = journalTextFields(body)
    if (row.kind === 'item' && row.v >= 5 && fields.length) {
      this.sparseAfter ??= row.seq
    }
    for (const field of fields) {
      const key = journalTextKey(itemId, field)
      const piece = this.pieces.get(key) ?? {
        itemId,
        field,
        marker: null,
        witness: null,
        revision: 0,
        head: null,
        tail: null,
        released: new Set<number>()
      }
      if (row.v >= 5 && row.kind === 'item') {
        piece.marker ??= { seq: row.seq, revision }
      }
      piece.witness = {
        seq: row.seq,
        revision,
        ...(row.kind === 'lifecycle-batch' ? { settlementId: row.settlementId } : {})
      }
      piece.revision = revision
      this.pieces.set(key, piece)
      this.reconsider(key, piece)
    }
  }
  select(key: string, piece: JournalTextPieces, budget: number) {
    let head = piece.head
    let position = head?.first ?? 0
    let examined = 0
    let runs = 0
    let lastSelected = 0
    const parked: number[] = []
    const released: number[] = []
    const sequences: number[] = []
    const release = piece.released.values()
    while (examined < budget && runs < 128) {
      const old = release.next().value
      const seq = old ?? (head && position < (piece.witness?.seq ?? 0) ? position : undefined)
      if (seq === undefined) {
        break
      }
      examined++
      if (old !== undefined) {
        released.push(seq)
      } else if (head) {
        if (position === head.last) {
          head = head.next
          position = head?.first ?? 0
        } else {
          position++
        }
      }
      if (this.isProtected(seq)) {
        parked.push(seq)
      } else {
        sequences.push(seq)
        if (lastSelected + 1 !== seq) {
          runs++
        }
        lastSelected = seq
      }
    }
    // Released exceptions can precede or follow unexamined work; only the bounded selection sorts.
    sequences.sort((a, b) => a - b)
    const ordered: JournalSequenceRange[] = []
    for (const seq of sequences) {
      const last = ordered.at(-1)
      if (last && last[1] + 1 === seq) {
        ordered[ordered.length - 1] = [last[0], seq]
      } else {
        ordered.push([seq, seq])
      }
    }
    return {
      sequences,
      ranges: ordered,
      examined,
      commit: () => {
        piece.head = head
        if (head) {
          head.first = position
        } else {
          piece.tail = null
        }
        for (const seq of released) {
          piece.released.delete(seq)
        }
        for (const seq of parked) {
          this.parked.set(seq, key)
        }
        this.reconsider(key, piece)
      }
    }
  }
}
