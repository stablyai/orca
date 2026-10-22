import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'

const FIRST_ESTIMATE = 80

/** The drawn rows, as the measuring choice reads them. */
type DrawnRows = {
  keys: readonly string[]
  rows: readonly NativeChatMessage[]
  rowState: (index: number, row: NativeChatMessage) => MobileNativeChatTurnRow
  start: number
  /** The first row in the document: rows above it were never measured. */
  first: number
  following: boolean
}

type Entry = { px: number; row: NativeChatMessage; state: MobileNativeChatTurnRow; layout: string }

function sameState(a: MobileNativeChatTurnRow, b: MobileNativeChatTurnRow): boolean {
  const before = Object.entries(a)
  const after = new Map(Object.entries(b))
  return before.length === after.size && before.every(([name, value]) => after.get(name) === value)
}

/** Row heights as drawn. One holds while the row would draw the same: the same row object (unchanged
 *  rows keep theirs across a re-fold), the same row state and the same layout. A stale one keeps
 *  standing in for its row until it is measured again, so going stale never moves anything. */
export class MobileNativeChatPageHeights {
  private entries = new Map<string, Entry>()
  private sum = 0
  private samples = 0

  px(key: string | undefined): number | undefined {
    return key === undefined ? undefined : this.entries.get(key)?.px
  }

  /** For rows never drawn, which only ever sit below the reader. */
  estimate(): number {
    return this.samples > 0 ? this.sum / this.samples : FIRST_ESTIMATE
  }

  valid(
    key: string,
    row: NativeChatMessage,
    state: MobileNativeChatTurnRow,
    layout: string
  ): boolean {
    const entry = this.entries.get(key)
    return (
      entry !== undefined &&
      entry.row === row &&
      entry.layout === layout &&
      sameState(entry.state, state)
    )
  }

  remember(
    key: string,
    px: number,
    row: NativeChatMessage,
    state: MobileNativeChatTurnRow,
    layout: string
  ): void {
    if (!this.entries.has(key)) {
      this.samples += 1
    }
    this.sum += px - (this.entries.get(key)?.px ?? 0)
    this.entries.set(key, { px, row, state, layout })
  }

  sourceKeys(
    rows: readonly NativeChatMessage[],
    keyOf: (row: NativeChatMessage) => string,
    before: readonly string[] | undefined
  ): {
    keys: string[]
    changed: boolean
    indexOf: (key: string | undefined) => number | undefined
  } {
    let changed = before?.length !== rows.length
    const keys = rows.map((row, index) => {
      const key = keyOf(row)
      changed ||= before?.[index] !== key
      return key
    })
    let index: Map<string, number> | undefined
    const indexOf = (key: string | undefined) =>
      key === undefined ? undefined : (index ??= new Map(keys.map((k, at) => [k, at]))).get(key)
    return { keys, changed, indexOf }
  }

  /** Retired payloads die after their heights supplied trim slack; estimation stays numeric. */
  retain(keys: readonly string[]): void {
    const current = new Set(keys)
    for (const key of this.entries.keys()) {
      if (!current.has(key)) {
        this.entries.delete(key)
      }
    }
  }

  /** Spacer heights around the measuring rows `[m0, m1)` and the window `[start, end)`: above them
   *  only the measured run (from `first`, plus trim `slack`), between them, and below the window. */
  spacers(
    keys: readonly string[],
    [m0, m1]: [number, number],
    [start, end]: [number, number],
    slack: number
  ): { first: number; above: number; mid: number; bottom: number } {
    let [first, above, mid, bottom] = [m0, slack, 0, 0]
    for (let px = this.px(keys[first - 1]); first > 0 && px !== undefined;) {
      above += px
      first -= 1
      px = this.px(keys[first - 1])
    }
    for (let i = m1; i < start; i += 1) {
      mid += this.px(keys[i]) ?? 0
    }
    for (let i = end; i < keys.length; i += 1) {
      bottom += this.px(keys[i]) ?? this.estimate()
    }
    return { first, above, mid, bottom }
  }

  /** The run of rows nearest above `start` whose heights don't hold, `[from, to]`, at most `rows`
   *  long and within `reach` px of measured rows above the window; null when there is none. */
  nearestStale(
    drawn: Pick<DrawnRows, 'keys' | 'rows' | 'rowState' | 'start'>,
    layout: string,
    reach: number,
    rows: number
  ): [number, number] | null {
    const { keys, start } = drawn
    const valid = (i: number): boolean =>
      this.valid(keys[i]!, drawn.rows[i]!, drawn.rowState(i, drawn.rows[i]!), layout)
    let [to, distance] = [start - 1, 0]
    for (; to >= 0 && distance <= reach && valid(to); to -= 1) {
      distance += this.px(keys[to]) ?? 0
    }
    if (to < 0 || distance > reach) {
      return null
    }
    let from = to
    while (from > 0 && to - from + 1 < rows && !valid(from - 1)) {
      from -= 1
    }
    return [from, to]
  }

  /** The rows to measure next: stale ones within `near` px above the window; following, then the
   *  rows never drawn just above the measured run; then, with `full`, stale ones anywhere above. */
  next(
    drawn: DrawnRows,
    layout: string,
    near: number,
    rows: number,
    full: boolean
  ): [number, number] | null {
    const close = this.nearestStale(drawn, layout, near, rows)
    if (close || !drawn.following) {
      return close
    }
    if (drawn.first > 0) {
      return [Math.max(0, drawn.first - rows), drawn.first - 1]
    }
    return full ? this.nearestStale(drawn, layout, Infinity, rows) : null
  }

  clear(): void {
    this.entries.clear()
    this.sum = 0
    this.samples = 0
  }
}
