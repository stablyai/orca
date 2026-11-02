import type { IssueSourcePreference } from '../../shared/repo-types'
import { requestGiteaJsonWithHeaders } from './client'
import { resolveGiteaIssueSource } from './gitea-issue-source-resolution'
import type { GiteaAssignableUser } from './pr-reviewers-and-approvals'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'
import { parseTeaPaginationTotal } from './tea-api-response'

const PAGE_LIMIT = 50
const MAX_PAGES = 50

const labelIdsByRepo = new Map<string, Map<string, number>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function repoResource(repo: GiteaRepoRef, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${suffix}`
}

function labelCacheKey(repo: GiteaRepoRef): string {
  return `${repo.apiBaseUrl}|${repo.owner}|${repo.repo}`
}

/** @internal - exposed for tests only */
export function _resetGiteaLabelCache(): void {
  labelIdsByRepo.clear()
}

export function cachedGiteaLabelId(repo: GiteaRepoRef, name: string): number | null {
  return labelIdsByRepo.get(labelCacheKey(repo))?.get(name.trim()) ?? null
}

async function resolveRepo(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<GiteaRepoRef | null> {
  const resolved = await resolveGiteaIssueSource(
    repoPath,
    preference,
    connectionId,
    localGitOptions
  )
  return resolved.source
}

async function fetchPages(repo: GiteaRepoRef, path: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, headers } = await requestGiteaJsonWithHeaders<unknown>(repo, path, {
      searchParams: { page, limit: PAGE_LIMIT }
    })
    const pageItems = records(data)
    items.push(...pageItems)
    const total = parseTeaPaginationTotal(headers)
    if (pageItems.length < PAGE_LIMIT || (total !== undefined && items.length >= total)) {
      break
    }
  }
  return items
}

export async function listGiteaLabels(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string[]> {
  const repo = await resolveRepo(repoPath, preference, connectionId, localGitOptions)
  if (!repo) {
    return []
  }
  try {
    const labels = await fetchPages(repo, repoResource(repo, '/labels'))
    const ids = new Map<string, number>()
    const names: string[] = []
    for (const label of labels) {
      const name = readString(label, 'name')
      if (!name || ids.has(name)) {
        continue
      }
      const id = readNumber(label, 'id')
      if (id !== null) {
        ids.set(name, id)
      }
      names.push(name)
    }
    labelIdsByRepo.set(labelCacheKey(repo), ids)
    return names
  } catch {
    return []
  }
}

function mapAssignableUser(record: Record<string, unknown>): GiteaAssignableUser | null {
  const username = readString(record, 'login') || readString(record, 'username')
  if (!username) {
    return null
  }
  const id = readNumber(record, 'id')
  const name = readString(record, 'full_name') || readString(record, 'name')
  return {
    ...(id !== null ? { id } : {}),
    username,
    name: name || null,
    avatarUrl: readString(record, 'avatar_url')
  }
}

export async function listGiteaAssignableUsers(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaAssignableUser[]> {
  const repo = await resolveRepo(repoPath, preference, connectionId, localGitOptions)
  if (!repo) {
    return []
  }
  try {
    const users = await fetchPages(repo, repoResource(repo, '/assignees'))
    const seen = new Set<string>()
    const mapped: GiteaAssignableUser[] = []
    for (const user of users) {
      const assignee = mapAssignableUser(user)
      if (!assignee) {
        continue
      }
      const key = assignee.username.toLowerCase()
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      mapped.push(assignee)
    }
    return mapped
  } catch {
    return []
  }
}
