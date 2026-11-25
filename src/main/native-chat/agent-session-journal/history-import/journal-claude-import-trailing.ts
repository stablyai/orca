import { Row, type ClaudeImportRows } from './journal-claude-import-rows'
import { setImmediate } from 'node:timers/promises'
import { Flag, Key, SLAB_ROWS, type Table } from './journal-claude-import-index-storage'

export async function selectClaudeTrailingRows(
  rows: ClaudeImportRows,
  keys: Table,
  anchor: number,
  terminal: number,
  hasQueuedPrompts: boolean,
  check: () => void
): Promise<void> {
  const has = (row: number, flag: Flag) => (rows.get(row, Row.Flags) & flag) !== 0
  const mark = (row: number, flag: Flag) =>
    rows.set(row, Row.Flags, rows.get(row, Row.Flags) | flag)
  const parent = (row: number) => keys.get(rows.get(row, Row.Parent), Key.LatestRow)
  const canonicalUuid = (row: number) => keys.get(rows.get(row, Row.Uuid), Key.LatestRow) === row
  let steps = 0

  if (hasQueuedPrompts) {
    for (let row = 1; row <= rows.length; row++) {
      if (++steps % SLAB_ROWS === 0) {
        await setImmediate()
        check()
      }
      if (!has(row, Flag.Turn) || has(row, Flag.Selected) || !canonicalUuid(row)) {
        continue
      }
      // An unselected turn owns the queued prompts on its path back to the selected history.
      for (
        let link = parent(row);
        link && !has(link, Flag.Selected | Flag.UnselectedTurnPath);
        link = parent(link)
      ) {
        mark(link, Flag.UnselectedTurnPath)
        if (++steps % SLAB_ROWS === 0) {
          await setImmediate()
          check()
        }
      }
    }
    mark(anchor, Flag.TrailingReachable)
    for (let row = 1; row <= rows.length; row++) {
      if (++steps % SLAB_ROWS === 0) {
        await setImmediate()
        check()
      }
      if (!has(row, Flag.QueuedPrompt) || !canonicalUuid(row)) {
        continue
      }
      let link = row
      while (
        link &&
        !has(link, Flag.Selected | Flag.Turn | Flag.TrailingVisited | Flag.TrailingReachable)
      ) {
        mark(link, Flag.TrailingVisited)
        link = parent(link)
        if (++steps % SLAB_ROWS === 0) {
          await setImmediate()
          check()
        }
      }
      if (has(link, Flag.TrailingReachable)) {
        for (let path = row; path !== link; path = parent(path)) {
          mark(path, Flag.TrailingReachable)
        }
      }
    }
  }

  // Local command replies only carry presentation on the winning terminal path.
  for (let row = terminal; row !== anchor; row = parent(row)) {
    if (++steps % SLAB_ROWS === 0) {
      await setImmediate()
      check()
    }
    if (has(row, Flag.Decode) && !has(row, Flag.QueuedPrompt)) {
      mark(row, Flag.Selected)
    }
  }
  if (hasQueuedPrompts) {
    for (let row = 1; row <= rows.length; row++) {
      if (++steps % SLAB_ROWS === 0) {
        await setImmediate()
        check()
      }
      if (
        has(row, Flag.QueuedPrompt) &&
        has(row, Flag.TrailingReachable) &&
        !has(row, Flag.UnselectedTurnPath) &&
        canonicalUuid(row)
      ) {
        mark(row, Flag.Selected)
      }
    }
  }
}
