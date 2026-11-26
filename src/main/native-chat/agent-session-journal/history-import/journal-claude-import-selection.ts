import { Row, type ClaudeImportRows } from './journal-claude-import-rows'
import { setImmediate } from 'node:timers/promises'
import { Flag, Key, Link, SLAB_ROWS, type Table } from './journal-claude-import-index-storage'
import { selectClaudeTrailingRows } from './journal-claude-import-trailing'
import { closeClaudeToolForks } from './journal-claude-import-tool-forks'

export function selectClaudeImportRows(
  rows: ClaudeImportRows,
  keys: Table,
  links: Table,
  hasQueuedPrompts: boolean,
  check: () => void
) {
  return new ClaudeImportSelection(rows, keys, links).select(hasQueuedPrompts, check)
}

class ClaudeImportSelection {
  constructor(
    private readonly rows: ClaudeImportRows,
    private readonly keys: Table,
    private readonly links: Table
  ) {}
  private canonical(row: number): boolean {
    const uuid = this.rows.get(row, Row.Uuid)
    return !uuid || this.keys.get(uuid, Key.LatestRow) === row
  }

  private parent(row: number): number {
    return this.keys.get(this.rows.get(row, Row.Parent), Key.LatestRow)
  }

  private has(row: number, flag: Flag): boolean {
    return (this.rows.get(row, Row.Flags) & flag) !== 0
  }

  private flag(row: number, flag: Flag): void {
    if (row) {
      this.rows.set(row, Row.Flags, this.rows.get(row, Row.Flags) | flag)
    }
  }

  private attach(row: number, parent: number): void {
    if (parent) {
      const head = this.keys.get(parent, Key.Child)
      this.rows.set(row, Row.Next, head)
      if (head) {
        this.rows.set(head, Row.Previous, row)
      }
      this.keys.set(parent, Key.Child, row)
    }
  }

  private reparent(row: number, parent: number): void {
    const before = this.rows.get(row, Row.Parent)
    if (before === parent) {
      return
    }
    const next = this.rows.get(row, Row.Next)
    const previous = this.rows.get(row, Row.Previous)
    if (previous) {
      this.rows.set(previous, Row.Next, next)
    } else if (before) {
      this.keys.set(before, Key.Child, next)
    }
    if (next) {
      this.rows.set(next, Row.Previous, previous)
    }
    this.rows.set(row, Row.Parent, parent)
    this.rows.set(row, Row.Previous, 0)
    this.rows.set(row, Row.Next, 0)
    this.attach(row, parent)
  }

  private async rewire(check: () => void): Promise<void> {
    for (let row = 1; row <= this.rows.length; row++) {
      if (row % SLAB_ROWS === 0) {
        await setImmediate()
        check()
      }
      if (this.canonical(row)) {
        this.attach(row, this.rows.get(row, Row.Parent))
      }
    }
    let visited = 0
    const latest = (key: number) => this.keys.get(key, Key.LatestRow)
    for (let row = 1; row <= this.rows.length; row++) {
      if (++visited % SLAB_ROWS === 0) {
        await setImmediate()
        check()
      }
      const key = this.rows.get(row, Row.Uuid)
      if (row !== this.keys.get(key, Key.FirstRow)) {
        continue
      }
      const compact = this.rows.get(latest(key), Row.Compact) | 0
      if (!compact) {
        continue
      }
      const anchor = this.links.get(Math.abs(compact), Link.Key)
      const members = this.links.get(Math.abs(compact), Link.Next)
      const head = this.links.get(members, Link.Key)
      let tail = this.links.get(members, Link.Next)
      if (compact > 0) {
        let valid = true
        for (let link = members; link && valid; link = this.links.get(link, Link.Next)) {
          valid = Boolean(latest(this.links.get(link, Link.Key)))
          if (++visited % SLAB_ROWS === 0) {
            await setImmediate()
            check()
          }
        }
        if (!valid) {
          continue
        }
        tail = anchor
        for (let link = members; link; link = this.links.get(link, Link.Next)) {
          const member = this.links.get(link, Link.Key)
          this.reparent(latest(member), tail)
          tail = member
        }
      } else if (latest(head)) {
        this.reparent(latest(head), anchor)
      }
      if (anchor !== tail) {
        for (let child = this.keys.get(anchor, Key.Child); child;) {
          if (++visited % SLAB_ROWS === 0) {
            await setImmediate()
            check()
          }
          const next = this.rows.get(child, Row.Next)
          if (this.rows.get(child, Row.Uuid) !== head) {
            this.reparent(child, tail)
          }
          child = next
        }
      }
    }
  }

  private async leaf(check: () => void): Promise<{ anchor: number; terminal: number }> {
    let visited = 0
    for (let row = 1; row <= this.rows.length; row++) {
      if (++visited % SLAB_ROWS === 0) {
        await setImmediate()
        check()
      }
      if (this.canonical(row) && this.rows.get(row, Row.Uuid)) {
        const parent = this.parent(row)
        this.flag(parent, Flag.HasChild)
        if (this.has(row, Flag.Leaf)) {
          this.flag(parent, Flag.HasLeafChild)
        }
      }
    }
    for (let row = this.rows.length; row > 0; row--) {
      if (++visited % SLAB_ROWS === 0) {
        await setImmediate()
        check()
      }
      if (
        !this.canonical(row) ||
        !this.rows.get(row, Row.Uuid) ||
        !this.has(row, Flag.Leaf) ||
        this.has(row, Flag.HasLeafChild)
      ) {
        continue
      }
      // Mark a traversed marker on sight so dead ends and cycles are visited once.
      let cursor = row
      while (cursor && !this.has(cursor, Flag.Exhausted)) {
        if (++visited % SLAB_ROWS === 0) {
          await setImmediate()
          check()
        }
        if (this.has(cursor, Flag.Turn)) {
          return { anchor: cursor, terminal: row }
        }
        this.flag(cursor, Flag.Exhausted)
        cursor = this.parent(cursor)
      }
    }
    const fallback = await this.latestTurnBehindLeaf(check)
    if (fallback) {
      return { anchor: fallback, terminal: fallback }
    }
    // A graph of system/progress rows can still contain a presentable local-command reply.
    for (let row = this.rows.length; row > 0; row--) {
      if (++visited % SLAB_ROWS === 0) {
        await setImmediate()
        check()
      }
      if (this.canonical(row) && this.rows.get(row, Row.Uuid) && this.has(row, Flag.Decode)) {
        return { anchor: row, terminal: row }
      }
    }
    return { anchor: 0, terminal: 0 }
  }

  private async latestTurnBehindLeaf(check: () => void): Promise<number> {
    let visible = 0
    let any = 0
    let visited = 0
    for (let row = 1; row <= this.rows.length; row++) {
      // Compact rewiring is complete, so the previous-child column can cache nearest turns.
      this.rows.set(row, Row.Previous, 0)
    }
    for (let leaf = this.rows.length; leaf > 0; leaf--) {
      if (++visited % SLAB_ROWS === 0) {
        await setImmediate()
        check()
      }
      if (
        !this.rows.get(leaf, Row.Uuid) ||
        !this.canonical(leaf) ||
        this.has(leaf, Flag.HasChild)
      ) {
        continue
      }
      let row = leaf
      let nearest = 0
      while (row) {
        if (++visited % SLAB_ROWS === 0) {
          await setImmediate()
          check()
        }
        const cached = this.rows.get(row, Row.Previous)
        if (cached) {
          nearest = cached - 1
          break
        }
        if (this.has(row, Flag.Turn)) {
          nearest = row
          break
        }
        this.rows.set(row, Row.Previous, 1)
        row = this.parent(row)
      }
      for (let parent = leaf; parent !== row; parent = this.parent(parent)) {
        this.rows.set(parent, Row.Previous, nearest + 1)
      }
      any = Math.max(any, nearest)
      if (!this.has(nearest, Flag.Meta)) {
        visible = Math.max(visible, nearest)
      }
    }
    return visible || any
  }

  async select(hasQueuedPrompts: boolean, check: () => void) {
    await this.rewire(check)
    const { anchor, terminal } = await this.leaf(check)
    let visited = 0
    let root = 0
    let pair: { boundary: number; summary: number } | undefined
    let row = anchor
    for (; row && !this.has(row, Flag.Selected); row = this.parent(row)) {
      if (++visited % SLAB_ROWS === 0) {
        await setImmediate()
        check()
      }
      this.flag(row, Flag.Selected)
      if (!pair && this.has(row, Flag.CompactSummary)) {
        const parent = this.parent(row)
        if (this.has(parent, Flag.CompactBoundary)) {
          pair = { boundary: parent, summary: row }
        }
      }
      this.rows.set(row, Row.Next, root)
      root = row
    }
    await closeClaudeToolForks(this.rows, this.keys, this.links, root, check)
    if (anchor && (hasQueuedPrompts || anchor !== terminal)) {
      await selectClaudeTrailingRows(
        this.rows,
        this.keys,
        anchor,
        terminal,
        hasQueuedPrompts,
        check
      )
    }
    return row ? undefined : pair
  }
}
