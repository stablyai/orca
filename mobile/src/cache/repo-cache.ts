// Why: repo metadata is mostly decorative and changes rarely. Keeping a short
// host-scoped cache lets workspace creation open from the last known list while
// a fresh repo.list refresh happens in the background.

import { normalizeExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import type { GitRemoteIdentity } from '../../../src/shared/git-remote-identity'
import type { GitHubRepositoryIdentity } from '../../../src/shared/github/pull-request-types'
import { normalizeRepoBadgeColor } from '../../../src/shared/repo-badge-color'
import { sanitizeRepoIcon, type RepoIcon } from '../../../src/shared/repo-icon'

export type CachedRepo = {
  id: string
  displayName: string
  path?: string
  badgeColor?: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  kind?: 'git' | 'folder'
  upstream?: GitHubRepositoryIdentity | null
  repoIcon?: RepoIcon | null
  gitRemoteIdentity?: GitRemoteIdentity | null
}

type CachedRepos = {
  repos: CachedRepo[]
  at: number
}

const cache = new Map<string, CachedRepos>()

const MAX_AGE_MS = 60_000
const MAX_ENTRIES = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function nullableString(value: unknown): value is string | null | undefined {
  return value === null || optionalString(value)
}

function readUpstream(value: unknown): GitHubRepositoryIdentity | null | undefined {
  if (value === undefined || value === null) {
    return value
  }
  if (
    !isRecord(value) ||
    typeof value.owner !== 'string' ||
    value.owner.length === 0 ||
    typeof value.repo !== 'string' ||
    value.repo.length === 0 ||
    !optionalString(value.host)
  ) {
    return undefined
  }
  return {
    owner: value.owner,
    repo: value.repo,
    ...(value.host ? { host: value.host } : {})
  }
}

function readGitRemoteIdentity(value: unknown): GitRemoteIdentity | null | undefined {
  if (value === undefined || value === null) {
    return value
  }
  if (
    !isRecord(value) ||
    typeof value.canonicalKey !== 'string' ||
    typeof value.remoteName !== 'string' ||
    typeof value.remoteUrl !== 'string'
  ) {
    return undefined
  }
  return {
    canonicalKey: value.canonicalKey,
    remoteName: value.remoteName,
    remoteUrl: value.remoteUrl
  }
}

function readRepo(value: unknown): CachedRepo | null {
  if (!isRecord(value)) {
    return null
  }
  const executionHostId =
    value.executionHostId === undefined || value.executionHostId === null
      ? value.executionHostId
      : typeof value.executionHostId === 'string'
        ? normalizeExecutionHostId(value.executionHostId)
        : null
  const badgeColor =
    value.badgeColor === undefined ? undefined : normalizeRepoBadgeColor(value.badgeColor)
  const repoIcon = sanitizeRepoIcon(value.repoIcon)
  const upstream = readUpstream(value.upstream)
  const gitRemoteIdentity = readGitRemoteIdentity(value.gitRemoteIdentity)
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.displayName !== 'string' ||
    !optionalString(value.path) ||
    !nullableString(value.connectionId) ||
    (value.executionHostId !== undefined && value.executionHostId !== null && !executionHostId) ||
    (value.badgeColor !== undefined && !badgeColor) ||
    (value.kind !== undefined && value.kind !== 'git' && value.kind !== 'folder') ||
    (value.upstream !== undefined && upstream === undefined) ||
    (value.repoIcon !== undefined && repoIcon === undefined) ||
    (value.gitRemoteIdentity !== undefined && gitRemoteIdentity === undefined)
  ) {
    return null
  }
  return {
    id: value.id,
    displayName: value.displayName,
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...(badgeColor ? { badgeColor } : {}),
    ...(value.connectionId !== undefined ? { connectionId: value.connectionId } : {}),
    ...(executionHostId !== undefined ? { executionHostId } : {}),
    ...(value.kind ? { kind: value.kind } : {}),
    ...(upstream !== undefined ? { upstream } : {}),
    ...(repoIcon !== undefined ? { repoIcon } : {}),
    ...(gitRemoteIdentity !== undefined ? { gitRemoteIdentity } : {})
  }
}

export function readMobileRepoCatalog(value: unknown): CachedRepo[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const repos = value.map(readRepo)
  return repos.every((repo) => repo !== null) ? repos : null
}

export function setCachedRepos(hostId: string, repos: unknown[]): void {
  const validated = readMobileRepoCatalog(repos)
  if (!validated) {
    return
  }
  cache.delete(hostId)
  cache.set(hostId, { repos: validated, at: Date.now() })
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest) {
      cache.delete(oldest)
    }
  }
}

export function getCachedRepos(
  hostId: string,
  options: { allowStale?: boolean } = {}
): CachedRepo[] | null {
  const entry = cache.get(hostId)
  if (!entry) {
    return null
  }
  if (!options.allowStale && Date.now() - entry.at > MAX_AGE_MS) {
    return null
  }
  const validated = readMobileRepoCatalog(entry.repos)
  if (!validated) {
    cache.delete(hostId)
    return null
  }
  return validated
}
