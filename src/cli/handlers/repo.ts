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
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime/types'

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

// Why: the runtime answers an add at an already-registered path with that row, whatever kind was
// asked for, so an explicit --kind only holds when the row agrees. Rows without a kind are git.
function assertRegisteredKind(
  added: RuntimeRpcSuccess<AddedRepo>,
  path: string,
  kind: RepoKind
): RuntimeRpcSuccess<AddedRepo> {
  const registeredKind: RepoKind = added.result.repo.kind === 'folder' ? 'folder' : 'git'
  if (registeredKind !== kind) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Cannot add ${path} as a ${kind} project: it is already registered as a ${registeredKind} project.`
    )
  }
  return added
}

export const REPO_HANDLERS: Record<string, CommandHandler> = {
  'repo list': async ({ client, json }) => {
    const result = await client.call<RuntimeRepoList>('repo.list')
    printResult(result, json, formatRepoList)
  },
  'repo add': async ({ flags, client, cwd, json }) => {
    const repoPath = getRequiredStringFlag(flags, 'path')
    const path = resolveRepoPathArgument(repoPath, cwd, client.isRemote, 'Remote repo add')
    const kind = getOptionalRepoKind(flags)
    const added = await addRepoOfDetectedKind(client, path, kind)
    printResult(kind ? assertRegisteredKind(added, path, kind) : added, json, formatRepoShow)
  },
  'repo show': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.show', {
      repo: getRequiredStringFlag(flags, 'repo')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo set': async ({ flags, client, json }) => {
    const repo = getRequiredStringFlag(flags, 'repo')
    const visibility = getRequiredStringFlag(flags, 'external-worktree-visibility')
    if (visibility !== 'show' && visibility !== 'hide' && visibility !== 'inherit') {
      throw new RuntimeClientError(
        'invalid_argument',
        '--external-worktree-visibility must be show, hide, or inherit.'
      )
    }
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.update', {
      repo,
      updates: { externalWorktreeVisibility: visibility === 'inherit' ? null : visibility }
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
