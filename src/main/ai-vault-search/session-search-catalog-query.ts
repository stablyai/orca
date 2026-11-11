import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCatalogBaseCommand } from './session-search-catalog-types'
import { sessionSearchInventoryStorage } from './session-search-inventory-storage'
import { sessionSearchInventoryRelation } from './session-search-inventory-relation'

export function sessionSearchCatalogPageRows(
  db: SyncDatabase,
  command: Extract<SessionSearchCatalogBaseCommand, { kind: 'page' }>,
  lane?: 'changed' | 'backlog'
) {
  const inventory = sessionSearchInventoryStorage(db)
  inventory.flush()
  const owner = inventory.owner(command.scope)
  const relation = owner && sessionSearchInventoryRelation(owner.member)
  const column = (name: 'key' | 'parent' | 'group' | 'rank' | 'ready' | 'tie') =>
    relation ? relation[name] : name === 'group' ? 'group_key' : name
  const conditions = owner ? [] : ['scope = ?']
  const values: (string | number)[] = [owner?.source ?? command.scope]
  if (lane) {
    // Simultaneous lane cursors must not share one cached native statement.
    conditions.push(lane === 'changed' ? "group_key='changed'" : "group_key='backlog'")
  }
  if (command.afterOrder) {
    const { rank, tie, key } = command.afterOrder
    conditions.push(
      command.orderRevision
        ? `(${column('tie')},${column('key')}) > (?,?)`
        : `(${column('rank')},${column('tie')},${column('key')}) > (?,?,?)`
    )
    values.push(...(command.orderRevision ? [tie, key] : [rank, tie, key]))
  } else if (command.after !== undefined) {
    if (command.orderRank || command.orderRevision) {
      throw new Error('Ordered session catalog continuation requires its full position')
    }
    conditions.push(`${column('key')} > ?`)
    values.push(command.after)
  }
  if (command.prefix !== undefined) {
    conditions.push(`${column('key')} >= ?`, `${column('key')} < ?`)
    values.push(command.prefix, `${command.prefix}\uffff`)
  }
  for (const [column, value] of [
    ['parent', command.parent],
    ['group', command.group],
    ['ready', command.ready]
  ] as const) {
    if (value !== undefined) {
      const name =
        owner?.member === 'files' && column === 'group' && value !== ''
          ? 'dependency'
          : relation
            ? relation[column]
            : column === 'group'
              ? 'group_key'
              : column
      conditions.push(`${name} = ?`)
      values.push(value)
    }
  }
  if (command.throughRevision !== undefined) {
    conditions.push(`${column('tie')} <= ?`)
    values.push(command.throughRevision)
  }
  if (command.beforeRank !== undefined) {
    conditions.push(`${column('rank')} <= ?`)
    values.push(command.beforeRank)
  }
  if (command.eligibleThrough !== undefined) {
    conditions.push(`(${column('ready')}=1 OR ${column('tie')}<=?)`)
    values.push(command.eligibleThrough)
  }
  const order = command.orderRevision
    ? (['tie', 'key'] as const)
    : command.orderRank
      ? (['rank', 'tie', 'key'] as const)
      : (['key'] as const)
  const sql = owner
    ? `${inventory.select(owner)}${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}`
    : `SELECT key,value,parent,group_key,rank,ready,tie FROM temp.search_catalog WHERE ${conditions.join(' AND ')}`
  const rows = db
    .prepare(
      `${sql} ORDER BY ${order
        .map(column)
        .filter((name) => name !== '0')
        .join(',')} LIMIT ?`
    )
    .iterate(...values, Math.max(1, Math.min(command.limit ?? 256, 256)))
  return (function* () {
    for (const raw of rows) {
      if (!owner) {
        yield raw
      } else {
        const row = inventory.decode(owner, raw)
        yield { ...row, group_key: row.group }
      }
    }
  })()
}
