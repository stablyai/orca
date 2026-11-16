import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { RuntimeWorktreeRecord } from '../../../../shared/worktree/catalog/runtime-worktree-contracts'

export type SshGitRemoteRead = (
  method: string,
  params: unknown
) => Promise<RuntimeRpcResponse<unknown>>

export type SshGitExecutionCatalog = {
  repos: Repo[]
  worktrees: RuntimeWorktreeRecord[]
  pending: Map<string, Promise<void>>
  refreshedAt: Map<string, number>
  repoSelectors: Map<string, string>
  worktreeSelectors: Map<string, string>
}

const CATALOG_TTL_MS = 10_000

export function isGitExecutionRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function gitExecutionParams(value: unknown): Record<string, unknown> {
  return isGitExecutionRecord(value) ? value : {}
}

export function readSshGitResult(response: RuntimeRpcResponse<unknown>): Record<string, unknown> {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return gitExecutionParams(response.result)
}

export function createSshGitExecutionCatalog(): SshGitExecutionCatalog {
  return {
    repos: [],
    worktrees: [],
    pending: new Map(),
    refreshedAt: new Map(),
    repoSelectors: new Map(),
    worktreeSelectors: new Map()
  }
}

async function refreshCatalog(
  catalog: SshGitExecutionCatalog,
  key: string,
  read: () => Promise<void>
): Promise<void> {
  if (Date.now() - (catalog.refreshedAt.get(key) ?? 0) < CATALOG_TTL_MS) {
    return
  }
  const pending = catalog.pending.get(key)
  if (pending) {
    return pending
  }
  const next = read().then(() => {
    catalog.refreshedAt.set(key, Date.now())
  })
  catalog.pending.set(key, next)
  try {
    await next
  } finally {
    if (catalog.pending.get(key) === next) {
      catalog.pending.delete(key)
    }
  }
}

export async function resolveSshGitExecutionRepo(
  catalog: SshGitExecutionCatalog,
  method: string,
  requestParams: Record<string, unknown>,
  readRemote: SshGitRemoteRead
): Promise<{ repo: Repo | undefined; params: Record<string, unknown> }> {
  const params = { ...requestParams }
  const nestedTarget = gitExecutionParams(params.gitExecutionTarget ?? params.target)
  const worktreeSelector = params.worktree ?? nestedTarget.worktree
  // GitHub's slug APIs use `repo` for the provider slug, not an Orca repository selector.
  const slugRequest = method.startsWith('github.project.') || nestedTarget.kind === 'slug'
  const repoSelector =
    params.gitExecutionRepo ?? (slugRequest ? undefined : (params.repo ?? nestedTarget.repo))
  let repo: Repo | undefined
  if (typeof worktreeSelector === 'string') {
    await refreshCatalog(catalog, `worktree:${worktreeSelector}`, async () => {
      const { worktree } = readSshGitResult(
        await readRemote('worktree.show', { worktree: worktreeSelector })
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authenticated worktree.show returns the owning server's RuntimeWorktreeRecord; its owner and Git identity are checked below.
      const row = worktree as RuntimeWorktreeRecord | undefined
      if (!row?.git || !row.repoId || (row.hostId && row.hostId !== 'local')) {
        throw new Error('The workspace does not belong to this SSH host')
      }
      const index = catalog.worktrees.findIndex((entry) => entry.id === row.id)
      if (index === -1) {
        catalog.worktrees.push(row)
      } else {
        catalog.worktrees[index] = row
      }
      catalog.worktreeSelectors.set(worktreeSelector, row.id)
      const result = readSshGitResult(await readRemote('repo.show', { repo: `id:${row.repoId}` }))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authenticated repo.show returns Repo metadata; require the selected worktree's repository on the SSH server itself.
      const repository = result.repo as Repo | undefined
      if (
        !repository ||
        repository.id !== row.repoId ||
        getRepoExecutionHostId(repository) !== 'local'
      ) {
        throw new Error('Nested SSH repositories cannot use desktop Git execution')
      }
      const repoIndex = catalog.repos.findIndex((entry) => entry.id === repository.id)
      if (repoIndex === -1) {
        catalog.repos.push(repository)
      } else {
        catalog.repos[repoIndex] = repository
      }
    })
    const worktree = catalog.worktrees.find(
      (row) => row.id === catalog.worktreeSelectors.get(worktreeSelector)
    )
    repo = catalog.repos.find((row) => row.id === worktree?.repoId)
    if (worktree) {
      if (typeof params.worktree === 'string') {
        params.worktree = `id:${worktree.id}`
      } else {
        params.target = { ...nestedTarget, worktree: `id:${worktree.id}` }
      }
    }
  } else if (typeof repoSelector === 'string') {
    await refreshCatalog(catalog, `repo:${repoSelector}`, async () => {
      const result = readSshGitResult(await readRemote('repo.show', { repo: repoSelector }))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authenticated repo.show returns Repo metadata; reject nested SSH ownership before using any local path.
      const row = result.repo as Repo | undefined
      if (!row || getRepoExecutionHostId(row) !== 'local') {
        throw new Error('Nested SSH repositories cannot use desktop Git execution')
      }
      const index = catalog.repos.findIndex((entry) => entry.id === row.id)
      if (index === -1) {
        catalog.repos.push(row)
      } else {
        catalog.repos[index] = row
      }
      catalog.repoSelectors.set(repoSelector, row.id)
    })
    repo = catalog.repos.find((row) => row.id === catalog.repoSelectors.get(repoSelector))
    if (repo) {
      if (typeof params.repo === 'string' && !slugRequest) {
        params.repo = `id:${repo.id}`
      } else if (!slugRequest) {
        params.target = { ...nestedTarget, repo: `id:${repo.id}` }
      }
    }
  }
  if ((worktreeSelector || repoSelector) && !repo) {
    throw new Error('The repository could not be resolved for desktop Git execution')
  }
  return { repo, params }
}
