import {
  GENERATED_INPUT_NOTICE_PAGE_BYTES,
  generatedInputNoticeFrames,
  type GeneratedAgentInputNotice,
  type GeneratedInputNoticesPage
} from '../../shared/generated-agent-input-notice'

type IndexRow = { added: number; id: string }
// One add-ordered seek index per audience ('' is shared): a reader walks only shared notices and
// its own, never another window's.
type AudienceIndex = { rows: IndexRow[]; live: number }

const audienceKey = (origin: string | null): string => origin ?? ''

/** Where each visible notice sits in its audience's add order, for bounded snapshot pages. */
export class GeneratedInputNoticeAudiences {
  private readonly indexes = new Map<string, AudienceIndex>()
  // Each visible record's place in its audience index.
  private readonly placed = new Map<string, { key: string; added: number }>()
  /** Index rows a page touched, for the operation-count contract (linear in what was sent). */
  pageVisits = 0

  get rows(): number {
    let rows = 0
    for (const index of this.indexes.values()) {
      rows += index.rows.length
    }
    return rows
  }

  isPlaced(id: string): boolean {
    return this.placed.has(id)
  }

  place(id: string, origin: string | null, added: number): void {
    const key = audienceKey(origin)
    let index = this.indexes.get(key)
    if (!index) {
      index = { rows: [], live: 0 }
      this.indexes.set(key, index)
    }
    index.rows.push({ added, id })
    index.live += 1
    this.placed.set(id, { key, added })
  }

  // Every removal keeps each index linear in its live notices (amortized compaction).
  unplace(id: string): void {
    const place = this.placed.get(id)
    if (!place) {
      return
    }
    this.placed.delete(id)
    const index = this.indexes.get(place.key)!
    index.live -= 1
    if (index.rows.length > 2 * index.live + 16) {
      index.rows = index.rows.filter((row) => this.placed.get(row.id)?.added === row.added)
    }
  }

  /** One bounded page for `viewer` into `page`, from the notice added at `cursor` (or the next
   *  one) at `offset`: shared notices and the viewer's own, merged in add order. */
  fillPage(
    page: GeneratedInputNoticesPage,
    noticeOf: (id: string) => GeneratedAgentInputNotice,
    cursor: number,
    offset: number,
    viewer: string | null,
    /** Bytes the page already holds. */
    spentBefore: number
  ): GeneratedInputNoticesPage {
    const lanes = [this.indexes.get('')?.rows ?? []]
    if (viewer) {
      lanes.push(this.indexes.get(viewer)?.rows ?? [])
    }
    const at = lanes.map((rows) => seek(rows, cursor))
    let spent = spentBefore
    for (;;) {
      // The next row in add order across the reader's lanes.
      let lane = -1
      for (let i = 0; i < lanes.length; i += 1) {
        if (
          at[i] < lanes[i].length &&
          (lane < 0 || lanes[i][at[i]].added < lanes[lane][at[lane]].added)
        ) {
          lane = i
        }
      }
      if (lane < 0) {
        return page
      }
      const { added, id } = lanes[lane][at[lane]]
      at[lane] += 1
      this.pageVisits += 1
      if (this.placed.get(id)?.added !== added) {
        continue
      }
      // A notice dismissed between pages restarts its successor from the beginning.
      const from = added === cursor ? offset : 0
      const { frames, next, bytes } = generatedInputNoticeFrames(
        noticeOf(id),
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
  }
}

function seek(rows: readonly IndexRow[], cursor: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (rows[mid].added < cursor) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return low
}
