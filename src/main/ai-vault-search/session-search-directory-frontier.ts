import { dirname, sep } from 'node:path'
import type { SessionSearchCatalog, SessionSearchCatalogRow } from './session-search-catalog'

export type SessionSearchDirectoryFrontierCommand =
  | {
      kind: 'directory-schedule'
      scope: string
      path: string
      depth: number
      reconcile: boolean
      remove?: boolean
    }
  | { kind: 'directory-cancel-step'; scope: string }
type Cancellation = { path: string; depth: number; cutoff: number; after?: string }
function frontier(
  row: SessionSearchCatalogRow | undefined
): { value: Cancellation; revision: number } | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: frontier wrappers are connection-private encoded records.
  return row ? (JSON.parse(row.value) as { value: Cancellation; revision: number }) : undefined
}

export function transitionSessionSearchDirectoryFrontier(
  catalog: SessionSearchCatalog,
  command: SessionSearchDirectoryFrontierCommand
) {
  const walks = `${command.scope}:walks`,
    cancellations = `${command.scope}:cancellations`
  const get = (scope: string, key: string) => catalog.execute({ kind: 'get', scope, key }).rows?.[0]
  const set = (scope: string, key: string, value: unknown) =>
    catalog.execute({ kind: 'frontier-set', scope, key, value: JSON.stringify(value) })
  if (command.kind === 'directory-schedule') {
    if (command.remove) {
      if (!get(cancellations, command.path)) {
        set(cancellations, command.path, {
          path: command.path,
          depth: command.depth,
          cutoff: catalog.nextRevision()
        })
      }
      return {}
    }
    if (get(walks, command.path)) {
      return {}
    }
    let child = command.path
    for (let depth = command.depth; depth >= 0; depth--) {
      if (get(`${command.scope}:directories`, child)) {
        break
      }
      catalog.execute({
        kind: 'put',
        scope: `${command.scope}:directories`,
        rows: [{ key: child, value: 'true', parent: dirname(child), group: '', rank: 0, ready: 0 }]
      })
      child = dirname(child)
    }
    set(walks, command.path, {
      path: command.path,
      depth: command.depth,
      reconcile: command.reconcile,
      phase: 'load'
    })
    return {}
  }
  const first = catalog.execute({
    kind: 'page',
    scope: cancellations,
    group: '',
    orderRank: true,
    limit: 1
  }).rows?.[0]
  const state = frontier(first)?.value
  if (!state || !first) {
    return {}
  }
  const remove = (row: SessionSearchCatalogRow | undefined) => {
    if (row && (frontier(row)?.revision ?? 0) <= state.cutoff) {
      catalog.execute({ kind: 'delete', scope: walks, key: row.key })
    }
  }
  if (state.after === undefined) {
    remove(get(walks, state.path))
  }
  const page = catalog.execute({
    kind: 'page',
    scope: walks,
    prefix: state.path.endsWith(sep) ? state.path : `${state.path}${sep}`,
    after: state.after,
    limit: state.after === undefined ? 255 : 256
  })
  for (const row of page.rows ?? []) {
    remove(row)
  }
  if (page.after !== undefined) {
    set(cancellations, first.key, { ...state, after: page.after })
  } else {
    catalog.execute({ kind: 'delete', scope: cancellations, key: first.key })
    if (!get(walks, state.path)) {
      set(walks, state.path, {
        path: state.path,
        depth: state.depth,
        reconcile: false,
        phase: 'remove-files'
      })
    }
  }
  return { processed: (page.rows?.length ?? 0) + Number(state.after === undefined) }
}
