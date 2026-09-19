import {
  isConfirmedStaleFolderPathStatus,
  type FolderWorkspacePathStatus
} from '../../shared/folder-workspace-path-status'
import { isNonGitRepoRejection } from '../../shared/non-git-repo-rejection'
import type { RepoKind } from '../../shared/repo-types'
import type { RuntimeRepoList, RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { formatRepoList, formatRepoRefs, formatRepoShow, printResult } from '../format'
import { getOptionalPositiveIntegerFlag, getRequiredStringFlag } from '../flags'
import { getOptionalRepoKind } from '../repo-kind-flag'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'

type AddedRepo = { repo: Record<string, unknown> }

// Best effort by design: folder registration accepts any absolute path, so this catches the typo
// the git attempt used to catch, and anything short of a positive refutation leaves the add alone.
async function refuseWhenHostRefutesDirectory(
  client: HandlerContext['client'],
  path: string
): Promise<void> {
  let status: FolderWorkspacePathStatus
  try {
    status = (
      await client.call<{ status: FolderWorkspacePathStatus }>('folderWorkspace.getPathStatus', {
        scope: 'path',
        path
      })
    ).result.status
  } catch {
    return
  }
  if (isConfirmedStaleFolderPathStatus(status)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Cannot add ${path}: the host reports no directory there.`
    )
  }
}

async function addFolderRepo(
  client: HandlerContext['client'],
  path: string
): Promise<RuntimeRpcSuccess<AddedRepo>> {
  await refuseWhenHostRefutesDirectory(client, path)
  return client.call<AddedRepo>('repo.add', { path, kind: 'folder' })
}

// Why: only the host holding the path can tell a checkout from a plain directory, so the runtime's
// non-git rejection drives the fallback — a paired server's filesystem is not the CLI's to stat.
async function addRepoOfDetectedKind(
  client: HandlerContext['client'],
  path: string,
  kind: RepoKind | undefined
): Promise<RuntimeRpcSuccess<AddedRepo>> {
  if (kind === 'folder') {
    return addFolderRepo(client, path)
  }
  try {
    return await client.call<AddedRepo>('repo.add', { path, ...(kind ? { kind } : {}) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (kind === 'git' || !isNonGitRepoRejection(message)) {
      throw error
    }
    return addFolderRepo(client, path)
  }
}

export const REPO_HANDLERS: Record<string, CommandHandler> = {
  'repo list': async ({ client, json }) => {
    const result = await client.call<RuntimeRepoList>('repo.list')
    printResult(result, json, formatRepoList)
  },
  'repo add': async ({ flags, client, cwd, json }) => {
    const repoPath = getRequiredStringFlag(flags, 'path')
    const result = await addRepoOfDetectedKind(
      client,
      resolveRepoPathArgument(repoPath, cwd, client.isRemote, 'Remote repo add'),
      getOptionalRepoKind(flags)
    )
    printResult(result, json, formatRepoShow)
  },
  'repo show': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.show', {
      repo: getRequiredStringFlag(flags, 'repo')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo set-base-ref': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.setBaseRef', {
      repo: getRequiredStringFlag(flags, 'repo'),
      ref: getRequiredStringFlag(flags, 'ref')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo search-refs': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeRepoSearchRefs>('repo.searchRefs', {
      repo: getRequiredStringFlag(flags, 'repo'),
      query: getRequiredStringFlag(flags, 'query'),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, formatRepoRefs)
  }
}
