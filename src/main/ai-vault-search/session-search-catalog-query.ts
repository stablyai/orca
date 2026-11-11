import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCatalogBaseCommand } from './session-search-catalog-types'

export function sessionSearchCatalogPageRows(
  db: SyncDatabase,
  command: Extract<SessionSearchCatalogBaseCommand, { kind: 'page' }>,
  lane?: 'changed' | 'backlog'
) {
  const conditions = ['scope = ?']
  const values: (string | number)[] = [command.scope]
  if (lane) {
    // Simultaneous lane cursors must not share one cached native statement.
    conditions.push(lane === 'changed' ? "group_key='changed'" : "group_key='backlog'")
  }
  if (command.afterOrder) {
    const { rank, tie, key } = command.afterOrder
    conditions.push(command.orderRevision ? '(tie,key) > (?,?)' : '(rank,tie,key) > (?,?,?)')
    values.push(...(command.orderRevision ? [tie, key] : [rank, tie, key]))
  } else if (command.after !== undefined) {
    if (command.orderRank || command.orderRevision) {
      throw new Error('Ordered session catalog continuation requires its full position')
    }
    conditions.push('key > ?')
    values.push(command.after)
  }
  if (command.prefix !== undefined) {
    conditions.push('key >= ?', 'key < ?')
    values.push(command.prefix, `${command.prefix}\uffff`)
  }
  for (const [column, value] of [
    ['parent', command.parent],
    ['group_key', command.group],
    ['ready', command.ready]
  ] as const) {
    if (value !== undefined) {
      conditions.push(`${column} = ?`)
      values.push(value)
    }
  }
  if (command.throughRevision !== undefined) {
    conditions.push('tie <= ?')
    values.push(command.throughRevision)
  }
  if (command.beforeRank !== undefined) {
    conditions.push('rank <= ?')
    values.push(command.beforeRank)
  }
  if (command.eligibleThrough !== undefined) {
    conditions.push('(ready=1 OR tie<=?)')
    values.push(command.eligibleThrough)
  }
  return db
    .prepare(`SELECT key,value,parent,group_key,rank,ready,tie FROM temp.search_catalog
    WHERE ${conditions.join(' AND ')} ORDER BY ${command.orderRevision ? 'tie,key' : command.orderRank ? 'rank,tie,key' : 'key'} LIMIT ?`)
    .iterate(...values, Math.max(1, Math.min(command.limit ?? 256, 256)))
}
