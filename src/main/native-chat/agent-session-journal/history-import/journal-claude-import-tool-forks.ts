import { Row, type ClaudeImportRows } from './journal-claude-import-rows'
import { setImmediate } from 'node:timers/promises'
import { Flag, Key, Link, SLAB_ROWS, type Table } from './journal-claude-import-index-storage'

export async function closeClaudeToolForks(
  rows: ClaudeImportRows,
  keys: Table,
  links: Table,
  root: number,
  check: () => void
) {
  const has = (row: number, flag: Flag) => (rows.get(row, Row.Flags) & flag) !== 0
  const uuid = (row: number) => rows.get(row, Row.Uuid)
  const select = (row: number) => rows.set(row, Row.Flags, rows.get(row, Row.Flags) | Flag.Selected)
  const message = (row: number) => rows.get(row, Row.Message)
  const latest = (key: number) => keys.get(key, Key.LatestRow)
  const ownerOf = (id: number) => keys.get(id, Key.Owner) | 0
  const sameAgent = (left: number, right: number) =>
    rows.get(left, Row.Agent) === rows.get(right, Row.Agent)
  let visited = 0
  let groups = false
  for (let row = root; row; row = rows.get(row, Row.Next)) {
    if (++visited % SLAB_ROWS === 0) {
      await setImmediate()
      check()
    }
    const group = message(row)
    if (group) {
      keys.set(group, Key.Group, 1)
      groups = true
    }
    if (has(row, Flag.ToolResult)) {
      for (const id of tools(row)) {
        keys.set(id, Key.Covered, 1)
      }
    }
  }
  if (!groups) {
    return
  }

  // First-seen UUID order is stable when a later occurrence supplies the row's fields.
  for (let first = 1; first <= rows.length; first++) {
    if (++visited % SLAB_ROWS === 0) {
      await setImmediate()
      check()
    }
    const key = uuid(first)
    if (!key || keys.get(key, Key.FirstRow) !== first) {
      continue
    }
    const row = latest(key)
    const group = message(row)
    if (!group) {
      continue
    }
    if (keys.get(group, Key.Group)) {
      rows.set(row, Row.Previous, keys.get(group, Key.Sibling))
      keys.set(group, Key.Sibling, row)
    }
    for (const id of tools(row)) {
      const owner = ownerOf(id)
      keys.set(id, Key.Owner, !owner || (owner > 0 && message(owner) === group) ? row : -1)
    }
  }

  // Prepending in reverse order gives stable first-seen order for cross-parent results.
  for (let first = rows.length; first > 0; first--) {
    if (++visited % SLAB_ROWS === 0) {
      await setImmediate()
      check()
    }
    const key = uuid(first)
    if (key && keys.get(key, Key.FirstRow) !== first) {
      continue
    }
    const row = key ? latest(key) : first
    const parent = rows.get(row, Row.Parent)
    if (!parent || !has(row, Flag.ToolResult) || has(row, Flag.Selected)) {
      continue
    }
    const direct = message(latest(parent))
    if (keys.get(direct, Key.Group)) {
      addResult(direct, row, Key.DirectResult)
    }
    const source = latest(rows.get(row, Row.SourceAssistant))
    if (source && sameAgent(source, row)) {
      associate(message(source), direct, row)
    }
    for (const id of tools(row)) {
      const owner = ownerOf(id)
      if (owner > 0 && sameAgent(owner, row)) {
        associate(message(owner), direct, row)
      }
    }
  }

  for (let row = root; row; row = rows.get(row, Row.Next)) {
    if (++visited % SLAB_ROWS === 0) {
      await setImmediate()
      check()
    }
    const group = message(row)
    if (keys.get(group, Key.Group) !== 1) {
      continue
    }
    keys.set(group, Key.Group, 2)
    for (
      let sibling = keys.get(group, Key.Sibling);
      sibling;
      sibling = rows.get(sibling, Row.Previous)
    ) {
      select(sibling)
    }
    for (const result of results(group, Key.DirectResult)) {
      if (!has(result, Flag.Selected)) {
        claim(group, result)
      }
    }
    for (const result of results(group, Key.CrossResult)) {
      if (has(result, Flag.Selected)) {
        continue
      }
      for (const id of tools(result)) {
        const owner = ownerOf(id)
        if (owner > 0 && message(owner) === group && !keys.get(id, Key.Covered)) {
          claim(group, result)
          break
        }
      }
    }
  }

  function claim(group: number, row: number): void {
    select(row)
    for (const id of tools(row)) {
      const owner = ownerOf(id)
      if (owner > 0 && message(owner) === group) {
        keys.set(id, Key.Covered, 1)
      }
    }
  }

  function associate(group: number, direct: number, row: number): void {
    if (
      group !== direct &&
      keys.get(group, Key.Group) &&
      keys.get(group, Key.ResultStamp) !== row
    ) {
      keys.set(group, Key.ResultStamp, row)
      addResult(group, row, Key.CrossResult)
    }
  }

  function addResult(group: number, row: number, list: Key.DirectResult | Key.CrossResult): void {
    keys.set(group, list, links.append(row, keys.get(group, list)))
  }

  function* tools(row: number): Iterable<number> {
    for (let link = rows.get(row, Row.Tool); link; link = links.get(link, Link.Next)) {
      yield links.get(link, Link.Key)
    }
  }

  function* results(group: number, list: Key.DirectResult | Key.CrossResult): Iterable<number> {
    for (let link = keys.get(group, list); link; link = links.get(link, Link.Next)) {
      yield links.get(link, Link.Key)
    }
  }
}
