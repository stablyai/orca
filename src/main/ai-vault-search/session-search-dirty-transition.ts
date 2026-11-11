import { SessionSearchAuthorityPage } from './session-search-authority-page'
import { recordSessionSearchInput } from './session-search-observation-authority'
import type { SessionSearchCatalog, SessionSearchCatalogRow } from './session-search-catalog'
import type { SessionSearchObservationDebt } from './session-search-inventory-transition'

export type SessionSearchDirtyCommand =
  | { kind: 'dirty-page'; scope: string }
  | { kind: 'dirty-ack'; scope: string; path: string; revision: number }
  | { kind: 'input-invalidate'; scope: string; path: string; force: boolean; subtree?: boolean }
export type SessionSearchDirtyResult = {
  dirtyInputs?: { path: string; force: boolean; dirtyRevision: number }[]
}
type Entry = { value: boolean; revision: number }
function entry(row: SessionSearchCatalogRow | undefined): Entry | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the matching frontier owns its encoded value and revision.
  return row ? (JSON.parse(row.value) as Entry) : undefined
}
export function wakeSessionSearchPrimaryFailures(
  catalog: SessionSearchCatalog,
  scope: string,
  prefix: string
): void {
  catalog.execute({
    kind: 'put',
    scope: `${scope}:primary-wakes`,
    rows: [
      {
        key: prefix,
        value: JSON.stringify({ cutoff: catalog.nextRevision() }),
        parent: '',
        group: '',
        rank: 0,
        ready: 1
      }
    ]
  })
}

export function invalidateSessionSearchPhysical(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string,
  force: boolean,
  delivered = true,
  subtree = false
) {
  if (delivered) {
    if (subtree) {
      wakeSessionSearchPrimaryFailures(catalog, scope, path)
    }
    if (force) {
      catalog.requireReason?.(path, 'force')
    }
  }
  for (const suffix of delivered ? ['refusals', 'file-refusals'] : []) {
    const debtScope = `${scope}:${suffix}`
    const row = catalog.execute({ kind: 'get', scope: debtScope, key: path }).rows?.[0]
    if (row) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refusal rows are written by the matching physical owner.
      const debt = JSON.parse(row.value) as SessionSearchObservationDebt
      catalog.execute({
        kind: 'put',
        scope: debtScope,
        rows: [
          {
            ...row,
            value: JSON.stringify({ ...debt, failures: 0, attempted: -1 }),
            ready: 1,
            tie: catalog.nextRevision()
          }
        ]
      })
      catalog.execute({ kind: 'delete', scope: `${debtScope}:eligible`, key: path })
    }
    if (subtree) {
      catalog.execute({ kind: 'retry-wake', scope: debtScope, prefix: path })
    }
  }
  const dirty = `${scope}:dirty`
  const current = entry(catalog.execute({ kind: 'get', scope: dirty, key: path }).rows?.[0])
  catalog.execute({
    kind: 'frontier-set',
    scope: dirty,
    key: path,
    value: JSON.stringify(force || current?.value || false)
  })
  if (delivered) {
    recordSessionSearchInput(catalog, scope, path, undefined, false, 0)
  }
}

export function transitionSessionSearchDirty(
  catalog: SessionSearchCatalog,
  command: SessionSearchDirtyCommand
): SessionSearchDirtyResult {
  if (command.kind === 'input-invalidate') {
    invalidateSessionSearchPhysical(
      catalog,
      command.scope,
      command.path,
      command.force,
      true,
      command.subtree
    )
    return {}
  }
  if (command.kind === 'dirty-ack') {
    acknowledgeSessionSearchDirty(catalog, command.scope, command.path, command.revision)
    const authority = new SessionSearchAuthorityPage(catalog, command.scope)
    authority.settle(command.path)
    authority.flush()
    return {}
  }
  const scope = `${command.scope}:dirty`,
    expansion = `${command.scope}:dirty-expansion`
  const page = catalog.execute({ kind: 'page', scope, group: '', orderRank: true })
  const dirtyInputs: { path: string; force: boolean; dirtyRevision: number }[] = []
  let remaining = 256
  for (const row of page.rows ?? []) {
    const fact = entry(row)!
    if (
      entry(catalog.execute({ kind: 'get', scope, key: row.key }).rows?.[0])?.revision !==
      fact.revision
    ) {
      continue
    }
    const stored = catalog.execute({ kind: 'get', scope: expansion, key: row.key }).rows?.[0]
    const cursor: { revision: number; after?: string; complete?: boolean } | undefined = stored
      ? JSON.parse(stored.value)
      : undefined
    if (cursor?.revision === fact.revision && cursor.complete) {
      dirtyInputs.push({ path: row.key, force: fact.value, dirtyRevision: fact.revision })
      remaining--
      if (!remaining) {
        break
      }
      continue
    }
    const owners = catalog.execute({
      kind: 'page',
      scope: `${command.scope}:files`,
      group: row.key,
      after: cursor?.revision === fact.revision ? cursor.after : undefined,
      limit: remaining
    })
    for (const owner of owners.rows ?? []) {
      invalidateSessionSearchPhysical(catalog, command.scope, owner.key, fact.value)
    }
    remaining -= owners.rows?.length ?? 0
    const more =
      owners.after !== undefined &&
      catalog.execute({
        kind: 'page',
        scope: `${command.scope}:files`,
        group: row.key,
        after: owners.after,
        limit: 1
      }).rows?.length
    if (more) {
      catalog.execute({
        kind: 'put',
        scope: expansion,
        rows: [{ ...row, value: JSON.stringify({ revision: fact.revision, after: owners.after }) }]
      })
    } else if (
      entry(catalog.execute({ kind: 'get', scope, key: row.key }).rows?.[0])?.revision ===
      fact.revision
    ) {
      catalog.execute({
        kind: 'put',
        scope: expansion,
        rows: [{ ...row, value: JSON.stringify({ revision: fact.revision, complete: true }) }]
      })
      dirtyInputs.push({ path: row.key, force: fact.value, dirtyRevision: fact.revision })
      remaining--
    }
    if (!remaining) {
      break
    }
  }
  return { dirtyInputs }
}

export function acknowledgeSessionSearchDirty(
  catalog: SessionSearchCatalog,
  owner: string,
  path: string,
  revision: number
): void {
  const scope = `${owner}:dirty`
  const current = entry(catalog.execute({ kind: 'get', scope, key: path }).rows?.[0])
  if (current?.revision !== revision) {
    return
  }
  catalog.execute({ kind: 'delete', scope, key: path })
  catalog.execute({ kind: 'delete', scope: `${owner}:dirty-expansion`, key: path })
}
