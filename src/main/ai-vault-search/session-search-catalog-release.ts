import { sessionSearchPrefixUpperBound } from './session-search-prefix-range'
import type { SessionSearchCatalogBaseCommand } from './session-search-catalog-types'
import type { SessionSearchCatalog } from './session-search-catalog'

export function releaseSessionSearchInventory(
  catalog: SessionSearchCatalog,
  command: Extract<
    SessionSearchCatalogBaseCommand,
    { kind: 'release' | 'release-parent' | 'release-prefix' }
  >
): { count: number } {
  let count = 0
  const drain = (filter: { prefix?: string; parent?: string }) => {
    for (;;) {
      const rows = catalog.execute({ kind: 'page', scope: command.scope, ...filter }).rows ?? []
      if (!rows.length) {
        break
      }
      for (const row of rows) {
        catalog.execute({ kind: 'delete', scope: command.scope, key: row.key })
      }
      count += rows.length
      catalog.inventory.invalidate()
    }
  }
  if (command.kind === 'release-prefix') {
    if (catalog.execute({ kind: 'get', scope: command.scope, key: command.prefix }).rows?.length) {
      catalog.execute({ kind: 'delete', scope: command.scope, key: command.prefix })
      count++
    }
    for (const separator of ['/', '\\']) {
      drain({ prefix: `${command.prefix}${separator}` })
    }
  } else {
    drain(command.kind === 'release-parent' ? { parent: command.parent } : {})
  }
  return { count }
}

export function releaseSessionSearchCatalog(
  catalog: SessionSearchCatalog,
  command: Extract<
    SessionSearchCatalogBaseCommand,
    { kind: 'release-scopes-page' | 'release-scopes' }
  >
): { count: number } {
  let count = 0
  const receipts = catalog.inventory.observation(command.scope)
    ? `${command.scope}:input-receipts`
    : ''
  do {
    catalog.inventory.flush()
    const next = catalog.connection
      .prepare(`SELECT scope FROM temp.search_catalog_counts
      WHERE n>0 AND (scope=? OR (scope>=? AND scope<?))
      ORDER BY CASE WHEN scope=? THEN 1 ELSE 0 END,scope LIMIT 1`)
      .get(
        command.scope,
        `${command.scope}:`,
        sessionSearchPrefixUpperBound(`${command.scope}:`),
        receipts
      )
    if (!next) {
      if (command.kind === 'release-scopes-page' && count > 0) {
        break
      }
      catalog.inventory.invalidate()
      catalog.connection
        .prepare(`DELETE FROM temp.search_inventory_sources WHERE scope=?
        AND NOT EXISTS (SELECT 1 FROM temp.search_catalog_counts
          WHERE n>0 AND (scope=? OR (scope>=? AND scope<?)))`)
        .run(
          command.scope,
          command.scope,
          `${command.scope}:`,
          sessionSearchPrefixUpperBound(`${command.scope}:`)
        )
      break
    }
    const scope = String(next.scope)
    const rows = catalog.execute({ kind: 'page', scope, limit: 256 - count }).rows ?? []
    if (!rows.length) {
      throw new Error(`Session catalog release did not advance: ${scope}`)
    }
    for (const row of rows) {
      catalog.execute({ kind: 'delete', scope, key: row.key })
    }
    count += rows.length
    catalog.inventory.invalidate()
  } while (command.kind === 'release-scopes' || count < 256)
  return { count }
}
