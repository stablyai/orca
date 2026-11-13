import { invalidateSessionSearchPhysical } from './session-search-dirty-transition'
import type { SessionSearchCatalog } from './session-search-catalog'
import { authorityRow } from './session-search-observation-authority'
import { isInsideSessionRoot } from '../ai-vault/discovery/session-file-discovery'

export const PRIMARY_FAILURE_SCOPE = 'primary-read-failures'

/** This scratch index points at failed coverage; the persisted row owns the failure allowance. */
export function recordSessionSearchPrimaryFailure(
  catalog: SessionSearchCatalog,
  path: string,
  failed: boolean,
  seed = false
): void {
  if (!failed) {
    catalog.execute({ kind: 'delete', scope: PRIMARY_FAILURE_SCOPE, key: path })
    return
  }
  if (seed && authorityRow(catalog, PRIMARY_FAILURE_SCOPE, path)) {
    return
  }
  catalog.connection.exec(`CREATE TEMP TRIGGER IF NOT EXISTS search_primary_failure_removed
    AFTER DELETE ON main.files BEGIN
      DELETE FROM search_catalog WHERE scope='primary-read-failures' AND key=OLD.path;
    END`)
  catalog.execute({
    kind: 'put',
    scope: PRIMARY_FAILURE_SCOPE,
    rows: [
      {
        key: path,
        value: 'true',
        parent: '',
        group: '',
        rank: 0,
        ready: 0,
        tie: seed ? 0 : catalog.nextRevision()
      }
    ]
  })
}

export function admitSessionSearchPrimaryFailures(
  catalog: SessionSearchCatalog,
  scope: string
): void {
  // Initial membership must seed saved failures before a recovery wake consumes its range.
  if (catalog.execute({ kind: 'count', scope: `${scope}:walks` }).count) {
    return
  }
  const wakes = `${scope}:primary-wakes`
  const wake = catalog.execute({ kind: 'page', scope: wakes, limit: 1 }).rows?.[0]
  if (!wake) {
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this owner encoded the finite wake cursor.
  const value = JSON.parse(wake.value) as { cutoff: number; after?: string }
  const page = catalog.execute({
    kind: 'page',
    scope: PRIMARY_FAILURE_SCOPE,
    prefix: wake.key,
    after: value.after,
    throughRevision: value.cutoff,
    limit: 64
  })
  for (const row of page.rows ?? []) {
    if (isInsideSessionRoot(wake.key, row.key)) {
      invalidateSessionSearchPhysical(catalog, scope, row.key, true)
    }
  }
  if (page.after) {
    catalog.execute({
      kind: 'put',
      scope: wakes,
      rows: [{ ...wake, value: JSON.stringify({ ...value, after: page.after }) }]
    })
  } else if (authorityRow(catalog, wakes, wake.key)?.value === wake.value) {
    catalog.execute({ kind: 'delete', scope: wakes, key: wake.key })
  }
}
