import {
  validSessionSearchRemoval,
  type SessionSearchRemovalReceipt
} from './session-search-observation-authority'
import type { SessionSearchCatalog } from './session-search-catalog'
import { invalidateSessionSearchPhysical } from './session-search-dirty-transition'

export type SessionSearchDependencyFanoutCommand =
  | {
      kind: 'dependency-remove'
      scope: string
      rows: { path: string; observation?: SessionSearchRemovalReceipt }[]
    }
  | { kind: 'dependency-deliver'; scope: string; keys: string[] }
  | {
      kind: 'dependency-fanout'
      scope: string
      physical: string
      metadata: boolean
      after?: string
    }
  | { kind: 'dependency-discard'; scope: string; after?: string }

export function transitionSessionSearchDependencyFanout(
  catalog: SessionSearchCatalog,
  command: SessionSearchDependencyFanoutCommand
) {
  if (command.kind === 'dependency-remove') {
    for (const row of command.rows) {
      if (!row.observation || validSessionSearchRemoval(catalog, row.path, row.observation)) {
        catalog.execute({ kind: 'delete', scope: command.scope, key: row.path })
      }
    }
    return {}
  }
  const delivered = `${command.scope}:delivered`
  const put = (scope: string, key: string, value: unknown, ready = 0, group = '') =>
    catalog.execute({
      kind: 'put',
      scope,
      rows: [{ key, value: JSON.stringify(value), parent: '', group, rank: 0, ready }]
    })
  if (command.kind === 'dependency-deliver') {
    for (const key of command.keys) {
      put(delivered, key, {})
      catalog.execute({ kind: 'delete', scope: `${command.scope}:changed`, key })
    }
    return {}
  }
  const keys = catalog.execute({ kind: 'page', scope: delivered, after: command.after, limit: 256 })
  let remaining = 256
  let previous = command.after
  for (const key of keys.rows ?? []) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this delivered-key scope owns the encoded cursor.
    const cursor = JSON.parse(key.value) as { after?: string }
    const owners = catalog.execute({
      kind: 'page',
      scope: `${command.scope}:owners`,
      parent: key.key,
      after: cursor.after,
      limit: command.kind === 'dependency-discard' ? 1 : remaining
    })
    if (command.kind === 'dependency-discard') {
      if (!owners.rows?.length) {
        catalog.execute({ kind: 'delete', scope: delivered, key: key.key })
      }
      continue
    }
    for (const owner of owners.rows ?? []) {
      if (command.metadata) {
        if (!catalog.requireReason?.(owner.key, 'metadata')) {
          put('discovery-metadata', owner.key, catalog.nextRevision())
        }
      } else {
        invalidateSessionSearchPhysical(catalog, command.physical, owner.key, true)
      }
    }
    remaining -= owners.rows?.length ?? 0
    const more =
      owners.after !== undefined &&
      catalog.execute({
        kind: 'page',
        scope: `${command.scope}:owners`,
        parent: key.key,
        after: owners.after,
        limit: 1
      }).rows?.length
    if (more) {
      put(delivered, key.key, { after: owners.after })
      return { after: previous, dependencyMore: true }
    }
    if (owners.rows?.length || cursor.after !== undefined) {
      catalog.execute({ kind: 'delete', scope: delivered, key: key.key })
    }
    previous = key.key
    if (!remaining) {
      return { after: key.key, dependencyMore: true }
    }
  }
  return { after: keys.after }
}
