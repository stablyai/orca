import {
  sessionSearchDirectoryEpoch,
  newerSessionSearchInput
} from './session-search-observation-authority'
import type { SessionSearchCatalog } from './session-search-catalog'
import { transitionSessionSearchInventory } from './session-search-inventory-transition'

export type SessionSearchDirectoryCommand = {
  kind: 'directory-step'
  epoch: number
  scope: string
  path: string
  phase: 'files' | 'children' | 'entries' | 'remove-files' | 'remove-children'
  after?: string
  reconcile: boolean
  depth: number
}
export type SessionSearchDirectoryResult = {
  invalidProof?: boolean
  directoryPage?: { key: string; directory: boolean }[]
  removedFiles?: string[]
}

/** Membership comparison stays beside the accepted rows and returns only the affected input page. */
export function transitionSessionSearchDirectory(
  catalog: SessionSearchCatalog,
  command: SessionSearchDirectoryCommand
): SessionSearchDirectoryResult & { after?: string } {
  const epoch = sessionSearchDirectoryEpoch(catalog, command.scope, command.path)
  if (!epoch?.sealed || epoch.revision !== command.epoch) {
    return { invalidProof: true }
  }
  const observation = catalog.inventoryObservation(command.scope)
  if (command.phase === 'files' || command.phase === 'remove-files') {
    const paths = observation.filesPage(command.path, command.after)
    const incoming = observation.staged(paths, command.epoch)
    const removed = paths.filter(
      (key) => command.phase === 'remove-files' || !incoming.get(key)?.file
    )
    const accepted = transitionSessionSearchInventory(catalog, {
      kind: 'forget-files',
      scope: command.scope,
      paths: removed,
      cutoff: epoch.cutoff
    })
    if ((accepted.removedFiles?.length ?? 0) < removed.length) {
      catalog.execute({
        kind: 'directory-schedule',
        scope: command.scope,
        path: command.path,
        depth: command.depth,
        reconcile: true,
        trailing: true
      })
    }
    return { removedFiles: accepted.removedFiles, after: paths.at(-1) }
  }
  if (command.phase === 'children' || command.phase === 'remove-children') {
    const paths = observation.directoryChildren(command.path, command.after)
    const incoming = observation.staged(paths, command.epoch)
    for (const key of paths) {
      if (command.phase === 'remove-children' || !incoming.get(key)?.directory) {
        if (newerSessionSearchInput(catalog, command.scope, key, epoch.cutoff)) {
          catalog.execute({
            kind: 'directory-schedule',
            scope: command.scope,
            path: key,
            depth: command.depth + 1,
            reconcile: true,
            trailing: true
          })
          continue
        }
        catalog.execute({
          kind: 'directory-schedule',
          scope: command.scope,
          path: key,
          depth: command.depth + 1,
          reconcile: false,
          remove: true,
          cutoff: epoch.cutoff
        })
      }
    }
    return { after: paths.at(-1) }
  }

  const entries = observation.stagedPage(command.path, command.epoch, command.after)
  const output: NonNullable<SessionSearchDirectoryResult['directoryPage']> = []
  for (const row of entries) {
    if (row.directory) {
      const known = observation.directory(row.key)
      if (!known) {
        observation.ensureDirectory(row.key)
      }
      if (command.reconcile || !known) {
        catalog.execute({
          kind: 'directory-schedule',
          scope: command.scope,
          path: row.key,
          depth: command.depth + 1,
          reconcile: command.reconcile
        })
      }
    } else if (row.file && (command.reconcile || !observation.file(row.key))) {
      output.push({ key: row.key, directory: false })
    }
  }
  return { directoryPage: output, after: entries.at(-1)?.key }
}
