import { readFileSync } from 'node:fs'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitHubApiRepository } from './github-api-repository'
import { isValidGitHubApiRepository } from './github-api-repository-validation'

export function parseGitHubOwnerRepoSlug(raw: unknown): GitHubApiRepository | null {
  if (typeof raw !== 'string') {
    return null
  }
  const parts = raw
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/')
  if (parts.length !== 2) {
    return null
  }
  const candidate: GitHubApiRepository = {
    owner: parts[0]?.trim() ?? '',
    repo: parts[1]?.trim() ?? '',
    host: 'github.com'
  }
  return isValidGitHubApiRepository(candidate) ? candidate : null
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function parseIssueRepositoryValue(raw: unknown): GitHubApiRepository | null {
  if (typeof raw === 'string') {
    return parseGitHubOwnerRepoSlug(raw)
  }
  if (!isObjectRecord(raw)) {
    return null
  }
  if (typeof raw.owner !== 'string' || typeof raw.repo !== 'string') {
    return null
  }
  const candidate: GitHubApiRepository = {
    owner: raw.owner.trim(),
    repo: raw.repo.trim(),
    host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : 'github.com'
  }
  return isValidGitHubApiRepository(candidate) ? candidate : null
}

export async function readLocalIssueRepositoryOverride(
  repoPath: string
): Promise<GitHubApiRepository | null> {
  try {
    const raw = await readFile(join(repoPath, '.orca', 'project.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isObjectRecord(parsed) ? parseIssueRepositoryValue(parsed.issueRepository) : null
  } catch {
    return null
  }
}

const projectedIssueRepoCache = new Map<
  string,
  { expiresAt: number; value: GitHubApiRepository | null }
>()
const PROJECTED_ISSUE_REPO_CACHE_TTL_MS = 2_000

export function readProjectedLocalIssueRepositorySync(
  repoPath: string
): GitHubApiRepository | null {
  const now = Date.now()
  const cached = projectedIssueRepoCache.get(repoPath)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }
  let resolved: GitHubApiRepository | null = null
  try {
    const rawOverride = readFileSync(join(repoPath, '.orca', 'project.json'), 'utf8')
    const parsedOverride: unknown = JSON.parse(rawOverride)
    resolved = isObjectRecord(parsedOverride)
      ? parseIssueRepositoryValue(parsedOverride.issueRepository)
      : null
  } catch {
    resolved = null
  }
  if (!resolved) {
    try {
      const rawSdlc = readFileSync(join(repoPath, '.w0m', 'sdlc.json'), 'utf8')
      const parsedSdlc: unknown = JSON.parse(rawSdlc)
      const vcs =
        isObjectRecord(parsedSdlc) && isObjectRecord(parsedSdlc.vcs) ? parsedSdlc.vcs : null
      const provider =
        typeof vcs?.provider === 'string' ? vcs.provider.trim().toLowerCase() : 'github'
      const vcsRepo = provider === 'github' ? parseGitHubOwnerRepoSlug(vcs?.repo) : null
      if (vcsRepo) {
        let isWrapperOrigin = false
        try {
          const gitConfig = readFileSync(join(repoPath, '.git', 'config'), 'utf8')
          isWrapperOrigin = /-w0m(?:\.git)?\s*$/im.test(gitConfig)
        } catch {
          isWrapperOrigin = false
        }
        if (!isWrapperOrigin) {
          resolved = vcsRepo
        }
      }
    } catch {
      resolved = null
    }
  }
  projectedIssueRepoCache.set(repoPath, {
    expiresAt: now + PROJECTED_ISSUE_REPO_CACHE_TTL_MS,
    value: resolved
  })
  return resolved
}

export async function writeLocalIssueRepositoryOverride(
  repoPath: string,
  repository: { owner: string; repo: string; host?: string } | null
): Promise<void> {
  projectedIssueRepoCache.delete(repoPath)
  let rootStat: Awaited<ReturnType<typeof stat>>
  try {
    rootStat = await stat(repoPath)
  } catch {
    return
  }
  if (!rootStat.isDirectory()) {
    return
  }
  const orcaDir = join(repoPath, '.orca')
  const filePath = join(orcaDir, 'project.json')
  let existing: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    if (isObjectRecord(parsed)) {
      existing = { ...parsed }
    }
  } catch {
    existing = {}
  }
  const normalized = repository ? parseIssueRepositoryValue(repository) : null
  if (normalized) {
    existing.issueRepository = normalized
    await mkdir(orcaDir, { recursive: true })
    await writeFile(filePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
    return
  }
  delete existing.issueRepository
  if (Object.keys(existing).length === 0) {
    await unlink(filePath).catch(() => {})
    return
  }
  await mkdir(orcaDir, { recursive: true })
  await writeFile(filePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
}
