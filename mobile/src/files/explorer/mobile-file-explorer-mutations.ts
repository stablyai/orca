import type { QueryClient } from '@tanstack/react-query'
import { translate } from '../../i18n/mobile-i18n'
import { copyNameCandidate } from '../../../../src/shared/file-import/import-copy-name'
import { defineHostMutation } from '../../query/host-mutation'
import { hostQueryKey, hostScopeKey, type HostQueryTarget } from '../../query/host-query-key'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { captureMobileFileMutationOwnership } from '../mutation-ownership/mobile-file-mutation-ownership'
import { isFileExistsErrorMessage } from '../mutation-ownership/file-exists-error'
import { fileDirectoryQuery } from './mobile-file-explorer-operations'
import {
  explorerFileCopy,
  explorerFileCreate,
  explorerFolderCreate,
  explorerPathDelete,
  explorerPathRename,
  explorerPathsExistRead,
  explorerPathStat
} from './mobile-file-explorer-mutation-operations'

const FILE_MUTATION_TIMEOUT_MS = 15_000
// Removing a big folder (node_modules, build output) can take minutes on the host.
const FILE_DELETE_TIMEOUT_MS = 5 * 60_000
// Copy names are checked ten at a time ("a copy" through "a copy 10", then on), up to "a copy 100".
const DUPLICATE_NAMES_PER_CHECK = 10
const MAX_DUPLICATE_NAMES = 100

export type ExplorerTarget = HostQueryTarget & { worktree: string }

export function parentPathOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/')
  return slash === -1 ? '' : relativePath.slice(0, slash)
}

export function childPathOf(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/** The path itself or anything under it, as the explorer spells relative paths. */
export function isPathOrDescendant(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

// A name may hold slashes ("src/new.txt", as desktop allows), so every folder from `base` down to the
// entry's parent can gain a row; each is listed once.
function foldersGainingRow(base: string, relativePath: string): string[] {
  const parent = parentPathOf(relativePath)
  const inside =
    base && parent.startsWith(`${base}/`) ? parent.slice(base.length + 1) : base ? '' : parent
  const segments = inside ? inside.split('/') : []
  return [
    base,
    ...segments.map((_, index) => childPathOf(base, segments.slice(0, index + 1).join('/')))
  ]
}

export function explorerWorktreeSelector(target: ExplorerTarget): string {
  return `id:${target.worktree}`
}

function folderListingKey(hostId: string, target: ExplorerTarget, relativePath: string) {
  return hostQueryKey(hostId, fileDirectoryQuery.family, target, { relativePath })
}

// A renamed or deleted folder's cached listings would paint under a later folder of the same name.
function forgetListingsUnder(
  queryClient: QueryClient,
  hostId: string,
  target: ExplorerTarget,
  root: string
): void {
  queryClient.removeQueries({
    queryKey: [...hostScopeKey(hostId), fileDirectoryQuery.family, target],
    predicate: ({ queryKey }) => {
      const params: unknown = queryKey[4]
      return (
        typeof params === 'object' &&
        params !== null &&
        'relativePath' in params &&
        typeof params.relativePath === 'string' &&
        isPathOrDescendant(params.relativePath, root)
      )
    }
  })
}

async function pathsExist(
  client: RpcClient,
  target: ExplorerTarget,
  relativePaths: string[]
): Promise<boolean[]> {
  const answers = explorerPathsExistRead.interpret(
    await explorerPathsExistRead.request(
      client,
      { worktree: explorerWorktreeSelector(target), relativePaths },
      { timeoutMs: FILE_MUTATION_TIMEOUT_MS }
    )
  )
  if (answers.length !== relativePaths.length) {
    throw new Error('Invalid path existence response')
  }
  return answers.map((answer) => {
    if (answer.exists === undefined) {
      throw new Error(answer.error ?? 'Invalid path existence response')
    }
    return answer.exists
  })
}

// Every write names the host it expects, so a workspace that moved hosts refuses it instead of writing elsewhere.
function ownership(client: RpcClient, target: ExplorerTarget) {
  return captureMobileFileMutationOwnership(client, explorerWorktreeSelector(target))
}

export type CreateVars = {
  target: ExplorerTarget
  parent: string
  name: string
  kind: 'file' | 'folder'
}

async function sendCreate(client: RpcClient, vars: CreateVars): Promise<void> {
  const operation = vars.kind === 'file' ? explorerFileCreate : explorerFolderCreate
  const params = {
    worktree: explorerWorktreeSelector(vars.target),
    relativePath: childPathOf(vars.parent, vars.name),
    ...(await ownership(client, vars.target))
  }
  operation.interpret(
    await operation.request(client, params, { timeoutMs: FILE_MUTATION_TIMEOUT_MS })
  )
}

export const explorerCreate = defineHostMutation({
  offline: 'draft',
  send: sendCreate,
  // Creates never overwrite, so a lost reply is settled by the path being there, else by sending again.
  confirm: async (client, vars: CreateVars) => {
    const [exists] = await pathsExist(client, vars.target, [childPathOf(vars.parent, vars.name)])
    if (!exists) {
      await sendCreate(client, vars)
    }
  },
  // A folder made where one was cached earlier must not paint that one's rows.
  accept: (queryClient, hostId, vars) =>
    forgetListingsUnder(queryClient, hostId, vars.target, childPathOf(vars.parent, vars.name)),
  invalidates: (hostId, vars) =>
    foldersGainingRow(vars.parent, childPathOf(vars.parent, vars.name)).map((folder) =>
      folderListingKey(hostId, vars.target, folder)
    )
})

export type RenameVars = { target: ExplorerTarget; from: string; to: string }

async function sendRename(client: RpcClient, vars: RenameVars): Promise<void> {
  const params = {
    worktree: explorerWorktreeSelector(vars.target),
    oldRelativePath: vars.from,
    newRelativePath: vars.to,
    ...(await ownership(client, vars.target))
  }
  explorerPathRename.interpret(
    await explorerPathRename.request(client, params, { timeoutMs: FILE_MUTATION_TIMEOUT_MS })
  )
}

export const explorerRename = defineHostMutation({
  offline: 'draft',
  send: sendRename,
  confirm: async (client, vars: RenameVars) => {
    const [fromExists, toExists] = await pathsExist(client, vars.target, [vars.from, vars.to])
    if (fromExists || !toExists) {
      await sendRename(client, vars)
    }
  },
  // Neither the old path's listings nor any cached at the new path describe what is there now.
  accept: (queryClient, hostId, vars) => {
    forgetListingsUnder(queryClient, hostId, vars.target, vars.from)
    forgetListingsUnder(queryClient, hostId, vars.target, vars.to)
  },
  // One refresh when the name changes in place; more when a slash in it moves the entry into a subfolder.
  invalidates: (hostId, vars) =>
    foldersGainingRow(parentPathOf(vars.from), vars.to).map((folder) =>
      folderListingKey(hostId, vars.target, folder)
    )
})

type CopyVars = { target: ExplorerTarget; source: string; destination: string }

async function sendCopy(client: RpcClient, vars: CopyVars): Promise<void> {
  const params = {
    worktree: explorerWorktreeSelector(vars.target),
    sourceRelativePath: vars.source,
    destinationRelativePath: vars.destination,
    ...(await ownership(client, vars.target))
  }
  explorerFileCopy.interpret(
    await explorerFileCopy.request(client, params, { timeoutMs: FILE_MUTATION_TIMEOUT_MS })
  )
}

export const explorerCopy = defineHostMutation({
  offline: 'block',
  send: sendCopy,
  confirm: async (client, vars: CopyVars) => {
    const [exists] = await pathsExist(client, vars.target, [vars.destination])
    if (!exists) {
      await sendCopy(client, vars)
      return
    }
    // The host copies in place, so a copy still being written (or cut off) is there but short.
    const [source, copied] = await Promise.all(
      [vars.source, vars.destination].map(async (relativePath) =>
        explorerPathStat.interpret(
          await explorerPathStat.request(
            client,
            { worktree: explorerWorktreeSelector(vars.target), relativePath },
            { timeoutMs: FILE_MUTATION_TIMEOUT_MS }
          )
        )
      )
    )
    if (source.size !== copied.size) {
      throw new Error(
        translate(
          'files.fileExplorerRowActions.duplicateUnconfirmed',
          'The copy may not be complete. Check it and try again.'
        )
      )
    }
  },
  invalidates: (hostId, vars) => [
    folderListingKey(hostId, vars.target, parentPathOf(vars.destination))
  ]
})

export function noFreeCopyNameMessage(name: string): string {
  return translate(
    'files.fileExplorerRowActions.noFreeCopyName',
    'No free name for a copy of {{name}}',
    {
      name
    }
  )
}

/** Free names for a copy of `name` in `parent`, in desktop's order ("a copy.txt", "a copy 2.txt"), checked ten at a time. */
export async function* freeCopyPaths(
  client: RpcClient,
  target: ExplorerTarget,
  parent: string,
  name: string
): AsyncGenerator<string> {
  for (let first = 1; first <= MAX_DUPLICATE_NAMES; first += DUPLICATE_NAMES_PER_CHECK) {
    const names = Array.from({ length: DUPLICATE_NAMES_PER_CHECK }, (_, index) =>
      childPathOf(parent, copyNameCandidate(name, first + index))
    )
    const taken = await pathsExist(client, target, names)
    yield* names.filter((_, index) => !taken[index])
  }
}

/** Copies a file beside itself as desktop's Duplicate names it ("a copy.txt", "a copy 2.txt"); resolves to the copy's path. */
export async function duplicateExplorerFile(
  client: RpcClient,
  copy: (vars: CopyVars) => Promise<void>,
  target: ExplorerTarget,
  source: { relativePath: string; name: string }
): Promise<string> {
  // Free names are found before copying, as desktop checks; each copy is still no-clobber.
  for await (const destination of freeCopyPaths(
    client,
    target,
    parentPathOf(source.relativePath),
    source.name
  )) {
    try {
      await copy({ target, source: source.relativePath, destination })
      return destination
    } catch (error) {
      // Someone took the name since the check; the next free one is tried.
      if (error instanceof Error && isFileExistsErrorMessage(error.message)) {
        continue
      }
      throw error
    }
  }
  throw new Error(noFreeCopyNameMessage(source.name))
}

type DeleteVars = { target: ExplorerTarget; relativePath: string; isDirectory: boolean }

async function sendDelete(client: RpcClient, vars: DeleteVars): Promise<void> {
  const params = {
    worktree: explorerWorktreeSelector(vars.target),
    relativePath: vars.relativePath,
    recursive: vars.isDirectory,
    ...(await ownership(client, vars.target))
  }
  explorerPathDelete.interpret(
    await explorerPathDelete.request(client, params, { timeoutMs: FILE_DELETE_TIMEOUT_MS })
  )
}

export const explorerDelete = defineHostMutation({
  offline: 'block',
  send: sendDelete,
  // Never sent again: something new at the path since would be deleted without the user's say.
  confirm: async (client, vars: DeleteVars) => {
    const [exists] = await pathsExist(client, vars.target, [vars.relativePath])
    if (exists) {
      throw new Error(
        translate(
          'files.fileExplorerRowActions.deleteUnconfirmed',
          "It's still there. Check the folder and try again."
        )
      )
    }
  },
  accept: (queryClient, hostId, vars) =>
    forgetListingsUnder(queryClient, hostId, vars.target, vars.relativePath),
  invalidates: (hostId, vars) => [
    folderListingKey(hostId, vars.target, parentPathOf(vars.relativePath))
  ]
})
