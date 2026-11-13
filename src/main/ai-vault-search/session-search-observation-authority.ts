import { SessionSearchAuthorityPage, authorityValue } from './session-search-authority-page'
import type { SessionSearchCatalog, SessionSearchCatalogRow } from './session-search-catalog'

export { authorityValue } from './session-search-authority-page'

export type SessionSearchRemovalReceipt = { scope: string; revision: number; authority: number }
export function authorityRow(catalog: SessionSearchCatalog, scope: string, key: string) {
  return catalog.execute({ kind: 'get', scope, key }).rows?.[0]
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
  catalog.putValue(scope, { key, data: value, parent, group, rank, ready })
}
export function sessionSearchInputAuthority(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string
): number {
  return catalog.inventoryObservation(scope).authority(path)?.self ?? 0
}
export function recordSessionSearchInput(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string,
  revision = catalog.nextRevision(),
  ancestors = false,
  ready = 1
): number {
  const page = new SessionSearchAuthorityPage(catalog, scope)
  page.record(path, revision, ready)
  if (ancestors) {
    page.ensureDirectories(path)
  }
  page.flush()
  return revision
}
export function newerSessionSearchInput(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string,
  cutoff: number
): boolean {
  return new SessionSearchAuthorityPage(catalog, scope).newer(path, cutoff)
}

export function rearmSessionSearchAuthority(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string
): void {
  const observation = catalog.inventoryObservation(scope)
  const row = observation.authority(path)
  if (row && !row.ready) {
    observation.putAuthority(path, { ...row, ready: 1 })
  }
}
export function validSessionSearchRemoval(
  catalog: SessionSearchCatalog,
  path: string,
  receipt: SessionSearchRemovalReceipt
): boolean {
  const current = catalog.inventoryObservation(receipt.scope).delivery(path)
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
  return catalog.inventoryObservation(scope).directoryEpoch(path)
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
  catalog.inventoryObservation(scope).putDirectoryEpoch(path)
  putAuthorityValue(catalog, `${scope}:authority-garbage`, `${epoch}:${path}`, { path, epoch })
}
export function transitionSessionSearchAuthority(
  catalog: SessionSearchCatalog,
  command: SessionSearchAuthorityCommand
) {
  if (command.kind === 'authority-open') {
    catalog.inventory.open(command.scope, command.root)
    return {}
  }
  const observation = catalog.inventoryObservation(command.scope)
  if (command.kind === 'authority-probe') {
    const revision = recordSessionSearchInput(catalog, command.scope, command.path)
    observation.epoch(revision, command.path)
    return { observationEpoch: revision }
  }
  if (command.kind === 'authority-probe-end') {
    observation.epoch(command.revision)
    rearmSessionSearchAuthority(catalog, command.scope, command.path)
    return {
      invalidProof: newerSessionSearchInput(catalog, command.scope, command.path, command.revision)
    }
  }
  if (command.kind === 'directory-begin') {
    const revision = catalog.nextRevision()
    const cutoff = command.cutoff ?? revision
    observation.putDirectoryEpoch(command.path, {
      revision,
      cutoff,
      sealed: command.cutoff !== undefined
    })
    if (command.cutoff !== undefined) {
      observation.removalEpoch(command.path)
    }
    return { observationEpoch: revision }
  }
  if (command.kind === 'directory-stage' || command.kind === 'directory-seal') {
    const epoch = sessionSearchDirectoryEpoch(catalog, command.scope, command.path)
    if (!epoch || epoch.revision !== command.epoch || epoch.sealed) {
      return { invalidProof: true }
    }
    if (command.kind === 'directory-stage') {
      observation.stage(command.path, command.epoch, command.rows)
    } else {
      observation.putDirectoryEpoch(command.path, { ...epoch, sealed: true })
    }
    return {}
  }
  if (command.kind === 'directory-end') {
    const epoch = sessionSearchDirectoryEpoch(catalog, command.scope, command.path)
    const directoryProtected =
      !!epoch && newerSessionSearchInput(catalog, command.scope, command.path, epoch.cutoff)
    if (command.remove && epoch?.revision === command.epoch && !directoryProtected) {
      observation.removeDirectory(command.path)
    }
    endSessionSearchDirectory(catalog, command.scope, command.path, command.epoch)
    return { directoryProtected: command.remove && directoryProtected }
  }
  return cleanupSessionSearchAuthority(catalog, command.scope)
}

export function cleanupSessionSearchAuthority(catalog: SessionSearchCatalog, scope: string) {
  const observation = catalog.inventoryObservation(scope)
  const garbageScope = `${scope}:authority-garbage`
  const garbage = catalog.execute({ kind: 'page', scope: garbageScope, limit: 1 }).rows?.[0]
  if (garbage) {
    const value = authorityValue<{ path: string; epoch: number }>(garbage)!
    const keys = observation.stagedPage(value.path, value.epoch).map((row) => row.key)
    catalog.inventory.deleteStaged(
      `${scope}:directory-input`,
      value.path,
      String(value.epoch),
      keys
    )
    if (!observation.stagedPage(value.path, value.epoch, '', 1).length) {
      catalog.execute({ kind: 'delete', scope: garbageScope, key: garbage.key })
    }
    return {}
  }
  const floor = catalog.minimumFloor(scope)
  catalog.inventory.reclaimAuthority(
    scope,
    observation.readyAuthority(floor === Infinity ? catalog.nextRevision() : floor)
  )
  return {}
}
