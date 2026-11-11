import { dirname } from 'node:path'
import { isInsideSessionRoot } from '../ai-vault/session-file-discovery'
import type { SessionSearchCatalog, SessionSearchCatalogRow } from './session-search-catalog'

type Authority = { self: number; tree: number }
export type SessionSearchRemovalReceipt = { scope: string; revision: number; authority: number }
export function authorityRow(catalog: SessionSearchCatalog, scope: string, key: string) {
  return catalog.execute({ kind: 'get', scope, key }).rows?.[0]
}
export function authorityValue<T>(row: SessionSearchCatalogRow | undefined): T | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these connection-private records have one typed writer.
  return row ? (JSON.parse(row.value) as T) : undefined
}
export function putAuthorityValue(
  catalog: SessionSearchCatalog,
  scope: string,
  key: string,
  value: unknown,
  rank = 0,
  ready = 0,
  parent = '',
  group = ''
) {
  catalog.execute({
    kind: 'put',
    scope,
    rows: [{ key, value: JSON.stringify(value), parent, group, rank, ready }]
  })
}
function root(catalog: SessionSearchCatalog, scope: string): string | undefined {
  return authorityValue<string>(authorityRow(catalog, `${scope}:authority-root`, 'root'))
}
export function sessionSearchInputAuthority(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string
): number {
  return authorityValue<Authority>(authorityRow(catalog, `${scope}:authority`, path))?.self ?? 0
}
export function recordSessionSearchInput(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string,
  revision = catalog.nextRevision(),
  ancestors = false
): number {
  const base = root(catalog, scope)
  let key = path
  let direct = true
  do {
    const old = authorityValue<Authority>(authorityRow(catalog, `${scope}:authority`, key))
    putAuthorityValue(
      catalog,
      `${scope}:authority`,
      key,
      { self: direct ? revision : (old?.self ?? 0), tree: Math.max(revision, old?.tree ?? 0) },
      Math.max(revision, old?.tree ?? 0),
      1
    )
    if (ancestors && !direct && !authorityRow(catalog, `${scope}:directories`, key)) {
      putAuthorityValue(catalog, `${scope}:directories`, key, true, 0, 0, dirname(key))
    }
    if (!base || key === base || dirname(key) === key) {
      break
    }
    key = dirname(key)
    direct = false
  } while (isInsideSessionRoot(base, key))
  return revision
}
export function newerSessionSearchInput(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string,
  cutoff: number
): boolean {
  const base = root(catalog, scope)
  let key = path
  let direct = true
  do {
    const value = authorityValue<Authority>(authorityRow(catalog, `${scope}:authority`, key))
    if (
      (direct ? value?.tree : value?.self) !== undefined &&
      (direct ? value!.tree : value!.self) > cutoff
    ) {
      return true
    }
    if (!base || key === base || dirname(key) === key) {
      break
    }
    key = dirname(key)
    direct = false
  } while (isInsideSessionRoot(base, key))
  return false
}
export function rearmSessionSearchAuthority(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string
): void {
  const row = authorityRow(catalog, `${scope}:authority`, path)
  if (row && !row.ready) {
    catalog.execute({ kind: 'put', scope: `${scope}:authority`, rows: [{ ...row, ready: 1 }] })
  }
}
export function validSessionSearchRemoval(
  catalog: SessionSearchCatalog,
  path: string,
  receipt: SessionSearchRemovalReceipt
): boolean {
  const current = authorityValue<{ removed?: boolean; revision: number; authority: number }>(
    authorityRow(catalog, `${receipt.scope}:delivery`, path)
  )
  return (
    current?.removed === true &&
    current.revision === receipt.revision &&
    current.authority === receipt.authority &&
    !newerSessionSearchInput(catalog, receipt.scope, path, receipt.authority)
  )
}

export type SessionSearchAuthorityCommand =
  | { kind: 'authority-probe'; scope: string; path: string }
  | { kind: 'authority-probe-end'; scope: string; path: string; revision: number }
  | { kind: 'authority-open'; scope: string; root: string }
  | { kind: 'directory-begin'; scope: string; path: string; cutoff?: number }
  | {
      kind: 'directory-stage'
      scope: string
      path: string
      epoch: number
      rows: SessionSearchCatalogRow[]
    }
  | { kind: 'directory-seal'; scope: string; path: string; epoch: number }
  | { kind: 'directory-end'; scope: string; path: string; epoch: number; remove?: boolean }
  | { kind: 'authority-cleanup'; scope: string }
export type SessionSearchDirectoryEpoch = { revision: number; cutoff: number; sealed: boolean }
export function sessionSearchDirectoryEpoch(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string
) {
  return authorityValue<SessionSearchDirectoryEpoch>(authorityRow(catalog, `${scope}:epochs`, path))
}
export function endSessionSearchDirectory(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string,
  epoch: number
): void {
  if (sessionSearchDirectoryEpoch(catalog, scope, path)?.revision !== epoch) {
    return
  }
  catalog.execute({ kind: 'delete', scope: `${scope}:epochs`, key: path })
  putAuthorityValue(catalog, `${scope}:authority-garbage`, `${epoch}:${path}`, { path, epoch })
}
export function transitionSessionSearchAuthority(
  catalog: SessionSearchCatalog,
  command: SessionSearchAuthorityCommand
) {
  const epochs = `${command.scope}:epochs`
  if (command.kind === 'authority-probe') {
    const revision = recordSessionSearchInput(catalog, command.scope, command.path)
    putAuthorityValue(
      catalog,
      `${command.scope}:observation-epochs`,
      String(revision),
      command.path,
      revision
    )
    return { observationEpoch: revision }
  }
  if (command.kind === 'authority-probe-end') {
    catalog.execute({
      kind: 'delete',
      scope: `${command.scope}:observation-epochs`,
      key: String(command.revision)
    })
    rearmSessionSearchAuthority(catalog, command.scope, command.path)
    return {
      invalidProof: newerSessionSearchInput(catalog, command.scope, command.path, command.revision)
    }
  }
  if (command.kind === 'authority-open') {
    putAuthorityValue(catalog, `${command.scope}:authority-root`, 'root', command.root)
    return {}
  }
  if (command.kind === 'directory-begin') {
    const revision = catalog.nextRevision()
    const cutoff = command.cutoff ?? revision
    putAuthorityValue(
      catalog,
      epochs,
      command.path,
      { revision, cutoff, sealed: command.cutoff !== undefined },
      cutoff
    )
    if (command.cutoff !== undefined) {
      catalog.execute({
        kind: 'delete',
        scope: `${command.scope}:removal-epochs`,
        key: command.path
      })
    }
    return { observationEpoch: revision }
  }
  if (command.kind === 'directory-stage' || command.kind === 'directory-seal') {
    const epoch = sessionSearchDirectoryEpoch(catalog, command.scope, command.path)
    if (!epoch || epoch.revision !== command.epoch || epoch.sealed) {
      return { invalidProof: true }
    }
    if (command.kind === 'directory-stage') {
      catalog.execute({
        kind: 'put',
        scope: `${command.scope}:directory-input`,
        rows: command.rows.map((row) => ({ ...row, group: String(command.epoch) }))
      })
    } else {
      putAuthorityValue(catalog, epochs, command.path, { ...epoch, sealed: true }, epoch.cutoff)
    }
    return {}
  }
  if (command.kind === 'directory-end') {
    const epoch = sessionSearchDirectoryEpoch(catalog, command.scope, command.path)
    const directoryProtected =
      !!epoch && newerSessionSearchInput(catalog, command.scope, command.path, epoch.cutoff)
    if (command.remove && epoch?.revision === command.epoch && !directoryProtected) {
      catalog.execute({ kind: 'delete', scope: `${command.scope}:directories`, key: command.path })
    }
    endSessionSearchDirectory(catalog, command.scope, command.path, command.epoch)
    return { directoryProtected: command.remove && directoryProtected }
  }
  return cleanupSessionSearchAuthority(catalog, command.scope)
}

export function cleanupSessionSearchAuthority(catalog: SessionSearchCatalog, scope: string) {
  const garbageScope = `${scope}:authority-garbage`
  const garbage = catalog.execute({ kind: 'page', scope: garbageScope, limit: 1 }).rows?.[0]
  if (garbage) {
    const value = authorityValue<{ path: string; epoch: number }>(garbage)!
    const page = catalog.execute({
      kind: 'page',
      scope: `${scope}:directory-input`,
      parent: value.path,
      group: String(value.epoch)
    })
    catalog.execute({
      kind: 'delete-page',
      scope: `${scope}:directory-input`,
      keys: (page.rows ?? []).map((row) => row.key)
    })
    if (
      !catalog.execute({
        kind: 'page',
        scope: `${scope}:directory-input`,
        parent: value.path,
        group: String(value.epoch),
        limit: 1
      }).rows?.length
    ) {
      catalog.execute({ kind: 'delete', scope: garbageScope, key: garbage.key })
    }
    return {}
  }
  const floor = Math.min(
    ...['epochs', 'observation-epochs', 'removal-epochs'].map(
      (suffix) =>
        catalog.execute({
          kind: 'page',
          scope: `${scope}:${suffix}`,
          group: '',
          orderRank: true,
          limit: 1
        }).rows?.[0]?.rank ?? Infinity
    )
  )
  const page = catalog.execute({
    kind: 'page',
    scope: `${scope}:authority`,
    ready: 1,
    orderRank: true,
    beforeRank: floor === Infinity ? catalog.nextRevision() : floor
  })
  for (const row of page.rows ?? []) {
    const live = ['dirty', 'observing', 'refusals', 'file-refusals', 'delivery'].some(
      (suffix) => !!authorityRow(catalog, `${scope}:${suffix}`, row.key)
    )
    if (live) {
      catalog.execute({
        kind: 'put',
        scope: `${scope}:authority`,
        rows: [{ ...row, ready: 0 }]
      })
    } else {
      catalog.execute({ kind: 'delete', scope: `${scope}:authority`, key: row.key })
    }
  }
  return {}
}
