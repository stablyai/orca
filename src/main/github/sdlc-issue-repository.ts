import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GitHubApiRepository } from './github-api-repository'
import { isValidGitHubApiRepository } from './github-api-repository-validation'
import { shouldSkipDirectory } from '../project-groups/nested-repo-scan-rules'

export type SdlcWorkspaceConfig = {
  vcsRepo: GitHubApiRepository | null
  canonicalRepoSubpath: string | null
  repoSubpaths: string[]
}

export function parseGitHubOwnerRepoSlug(raw: unknown): GitHubApiRepository | null {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
  const parts = trimmed.split('/')
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

export function isGovernanceWrapperRepository(repo: GitHubApiRepository | null): boolean {
  return Boolean(repo && repo.repo.toLowerCase().endsWith('-w0m'))
}

export async function readSdlcWorkspaceConfig(
  repoPath: string
): Promise<SdlcWorkspaceConfig | null> {
  try {
    const raw = await readFile(join(repoPath, '.w0m', 'sdlc.json'), 'utf8')
    const parsed = JSON.parse(raw) as {
      canonical_repo?: unknown
      repos?: Record<string, unknown>
      vcs?: {
        provider?: unknown
        repo?: unknown
      }
    }
    const provider =
      typeof parsed?.vcs?.provider === 'string'
        ? parsed.vcs.provider.trim().toLowerCase()
        : 'github'
    const vcsRepo = provider === 'github' ? parseGitHubOwnerRepoSlug(parsed?.vcs?.repo) : null
    const canonicalRepoSubpath =
      typeof parsed?.canonical_repo === 'string' && parsed.canonical_repo.trim().length > 0
        ? parsed.canonical_repo.trim()
        : null
    const repoSubpaths: string[] = []
    if (parsed?.repos && typeof parsed.repos === 'object') {
      for (const value of Object.values(parsed.repos)) {
        if (typeof value === 'string' && value.trim().length > 0) {
          repoSubpaths.push(value.trim())
        }
      }
    }
    return {
      vcsRepo,
      canonicalRepoSubpath,
      repoSubpaths
    }
  } catch {
    return null
  }
}

async function hasGitMarkerAtPath(dirPath: string): Promise<boolean> {
  try {
    const marker = await stat(join(dirPath, '.git'))
    return marker.isDirectory() || marker.isFile()
  } catch {
    return false
  }
}

export async function findDirectChildGitRepoPaths(
  repoPath: string,
  preferredSubpaths: string[] = []
): Promise<string[]> {
  const results: string[] = []
  const seen = new Set<string>()

  const tryAddCandidate = async (candidatePath: string): Promise<void> => {
    const normalized = resolve(candidatePath)
    if (seen.has(normalized)) {
      return
    }
    if (await hasGitMarkerAtPath(candidatePath)) {
      seen.add(normalized)
      results.push(candidatePath)
    }
  }

  for (const subpath of preferredSubpaths) {
    if (!subpath || subpath === '.' || subpath.startsWith('/')) {
      continue
    }
    await tryAddCandidate(join(repoPath, subpath))
  }

  try {
    const entries = await readdir(repoPath, { withFileTypes: true })
    const dirs = entries
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          !entry.name.startsWith('.') &&
          !shouldSkipDirectory(entry.name, 0)
      )
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of dirs) {
      await tryAddCandidate(join(repoPath, entry.name))
    }
  } catch {
    // Ignore unreadable or virtual test paths.
  }

  return results
}

export async function resolveSdlcOrNestedIssueRepository(args: {
  repoPath: string
  origin: GitHubApiRepository | null
  connectionId?: string | null
  probeRemote: (
    targetPath: string,
    remoteName: 'origin' | 'upstream'
  ) => Promise<GitHubApiRepository | null>
}): Promise<GitHubApiRepository | null> {
  if (args.connectionId) {
    return args.origin
  }

  const sdlcConfig = await readSdlcWorkspaceConfig(args.repoPath)
  const preferredSubpaths = [
    ...(sdlcConfig?.canonicalRepoSubpath ? [sdlcConfig.canonicalRepoSubpath] : []),
    ...(sdlcConfig?.repoSubpaths ?? [])
  ]
  const wrapperOrMissingOrigin = !args.origin || isGovernanceWrapperRepository(args.origin)

  if (sdlcConfig?.vcsRepo && !wrapperOrMissingOrigin) {
    return sdlcConfig.vcsRepo
  }

  if (wrapperOrMissingOrigin) {
    const childPaths = await findDirectChildGitRepoPaths(args.repoPath, preferredSubpaths)
    for (const childPath of childPaths) {
      const childUpstream = await args.probeRemote(childPath, 'upstream')
      if (childUpstream) {
        return childUpstream
      }
      const childOrigin = await args.probeRemote(childPath, 'origin')
      if (childOrigin && !isGovernanceWrapperRepository(childOrigin)) {
        return childOrigin
      }
    }
    if (sdlcConfig?.vcsRepo) {
      return sdlcConfig.vcsRepo
    }
  }

  return args.origin
}

export async function resolveNestedPrRepositoryFallback(args: {
  repoPath: string
  origin: GitHubApiRepository | null
  connectionId?: string | null
  probeRemote: (
    targetPath: string,
    remoteName: 'origin' | 'upstream'
  ) => Promise<GitHubApiRepository | null>
}): Promise<{
  originCandidate: GitHubApiRepository | null
  upstreamCandidate: GitHubApiRepository | null
}> {
  if (args.connectionId || (args.origin && !isGovernanceWrapperRepository(args.origin))) {
    return { originCandidate: args.origin, upstreamCandidate: null }
  }

  const sdlcConfig = await readSdlcWorkspaceConfig(args.repoPath)
  const preferredSubpaths = [
    ...(sdlcConfig?.canonicalRepoSubpath ? [sdlcConfig.canonicalRepoSubpath] : []),
    ...(sdlcConfig?.repoSubpaths ?? [])
  ]
  const childPaths = await findDirectChildGitRepoPaths(args.repoPath, preferredSubpaths)
  for (const childPath of childPaths) {
    const [childOrigin, childUpstream] = await Promise.all([
      args.probeRemote(childPath, 'origin'),
      args.probeRemote(childPath, 'upstream')
    ])
    if (childOrigin || childUpstream) {
      return {
        originCandidate: childOrigin,
        upstreamCandidate: childUpstream
      }
    }
  }

  return { originCandidate: args.origin, upstreamCandidate: null }
}
