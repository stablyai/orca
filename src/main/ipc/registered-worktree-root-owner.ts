import { resolve } from 'node:path'
import { getRepoExecutionHostId, getSshTargetIdForExecutionHost } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'

export function getWorktreeRootOwnerKey(repo: Repo): string {
  return JSON.stringify([repo.id, resolve(repo.path), getRepoExecutionHostId(repo)])
}

export function getLocalWorktreeRootOwners(repos: readonly Repo[]): Map<string, Repo> {
  return new Map(
    repos
      .filter((repo) => !repo.connectionId && !getSshTargetIdForExecutionHost(repo.executionHostId))
      .map((repo) => [getWorktreeRootOwnerKey(repo), repo])
  )
}

export function resolveWorktreeRootOwner(
  repos: readonly Repo[],
  repo: Repo | string,
  owners: ReadonlyMap<string, Repo>
): string | undefined {
  // ID-only callers are safe only when the entire catalog has one matching row.
  if (typeof repo === 'string') {
    const matches = repos.filter((candidate) => candidate.id === repo)
    if (matches.length !== 1) {
      return undefined
    }
    repo = matches[0]
  }
  const key = getWorktreeRootOwnerKey(repo)
  return !repo.connectionId && owners.has(key) ? key : undefined
}
