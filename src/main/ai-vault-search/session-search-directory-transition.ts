import {
  sessionSearchDirectoryEpoch,
  newerSessionSearchInput
} from './session-search-observation-authority'
import type { SessionSearchCatalog } from './session-search-catalog'
import { dirname } from 'node:path'
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
  const entries = `${command.scope}:directory-input`
  const files = `${command.scope}:files`
  const directories = `${command.scope}:directories`
  const page = (scope: string) =>
    catalog.execute({ kind: 'page', scope, parent: command.path, after: command.after })
  const get = (scope: string, key: string) => catalog.execute({ kind: 'get', scope, key }).rows?.[0]
  const incoming = (key: string): { file?: boolean; directory?: boolean } => {
    const row = get(entries, key)
    const value: { file?: boolean; directory?: boolean } =
      row?.group === String(command.epoch) ? JSON.parse(row.value) : {}
    return value
  }
  if (command.phase === 'files' || command.phase === 'remove-files') {
    const result = page(files)
    const removed = (result.rows ?? [])
      .filter(({ key }) => command.phase === 'remove-files' || !incoming(key).file)
      .map(({ key }) => key)
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
    return { removedFiles: accepted.removedFiles, after: result.after }
  }
  if (command.phase === 'children' || command.phase === 'remove-children') {
    const result = page(directories)
    for (const row of result.rows ?? []) {
      if (command.phase === 'remove-children' || !incoming(row.key).directory) {
        if (newerSessionSearchInput(catalog, command.scope, row.key, epoch.cutoff)) {
          catalog.execute({
            kind: 'directory-schedule',
            scope: command.scope,
            path: row.key,
            depth: command.depth + 1,
            reconcile: true,
            trailing: true
          })
          continue
        }
        catalog.execute({
          kind: 'directory-schedule',
          scope: command.scope,
          path: row.key,
          depth: command.depth + 1,
          reconcile: false,
          remove: true,
          cutoff: epoch.cutoff
        })
      }
    }
    return { after: result.after }
  }

  const result = page(entries)
  const output: NonNullable<SessionSearchDirectoryResult['directoryPage']> = []
  for (const row of result.rows ?? []) {
    if (row.group !== String(command.epoch)) {
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this page contains this epoch's staged directory entries.
    const value = JSON.parse(row.value) as { file?: boolean; directory?: boolean }
    if (value.directory) {
      const known = get(directories, row.key)
      if (!known) {
        catalog.execute({
          kind: 'put',
          scope: directories,
          rows: [
            {
              key: row.key,
              value: 'true',
              parent: dirname(row.key),
              group: '',
              rank: 0,
              ready: 0
            }
          ]
        })
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
    } else if (value.file && (command.reconcile || !get(files, row.key))) {
      output.push({ key: row.key, directory: false })
    }
  }
  return { directoryPage: output, after: result.after }
}
