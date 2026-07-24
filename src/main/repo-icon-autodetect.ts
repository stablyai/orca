import { stat } from 'node:fs/promises'
import type { GitHubRepositoryIdentity, RepoKind } from '../shared/types'
import { faviconUrlFromWebsite, githubAvatarIcon, type RepoIcon } from '../shared/repo-icon'
import { getRepoSlug, getRepoUpstream } from './github/client'
import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider } from './providers/types'
import { detectGitRemoteIdentity } from './repo-git-remote-identity'
import { joinWorktreeRelativePath } from './runtime/runtime-relative-paths'
import { readNodeFileWithinLimit } from '../shared/node-bounded-file-reader'
import { detectLocalRepoPngIcon, detectRemoteRepoPngIcon } from './repo-icon-file-detection'

const WEBSITE_HOSTS_TO_SKIP = new Set([
  'github.com',
  'www.github.com',
  'gitlab.com',
  'www.gitlab.com',
  'bitbucket.org',
  'www.bitbucket.org'
])
function shouldUseWebsiteFavicon(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`)
    return !WEBSITE_HOSTS_TO_SKIP.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function packageHomepageIcon(packageJson: unknown): RepoIcon | null {
  if (!packageJson || typeof packageJson !== 'object') {
    return null
  }
  const homepage = (packageJson as { homepage?: unknown }).homepage
  if (typeof homepage !== 'string' || !shouldUseWebsiteFavicon(homepage)) {
    return null
  }
  const src = faviconUrlFromWebsite(homepage)
  return src ? { type: 'image', src, source: 'favicon', label: 'Website favicon' } : null
}

async function detectLocalPackageHomepageIcon(repoPath: string): Promise<RepoIcon | null> {
  try {
    const packageJsonPath = joinWorktreeRelativePath(repoPath, 'package.json')
    const info = await stat(packageJsonPath)
    if (!info.isFile() || info.size > 128 * 1024) {
      return null
    }
    const packageRead = await readNodeFileWithinLimit(packageJsonPath, 128 * 1024)
    if (!packageRead.stats.isFile()) {
      return null
    }
    return packageHomepageIcon(JSON.parse(packageRead.buffer.toString('utf8')))
  } catch {
    return null
  }
}

async function detectRemotePackageHomepageIcon(
  repoPath: string,
  fsProvider: IFilesystemProvider
): Promise<RepoIcon | null> {
  try {
    const packageJsonPath = joinWorktreeRelativePath(repoPath, 'package.json')
    const info = await fsProvider.stat(packageJsonPath)
    if (info.type !== 'file' || info.size > 128 * 1024) {
      return null
    }
    const result = await fsProvider.readFile(packageJsonPath)
    if (result.isBinary) {
      return null
    }
    if (Buffer.byteLength(result.content, 'utf8') > 128 * 1024) {
      return null
    }
    return packageHomepageIcon(JSON.parse(result.content))
  } catch {
    return null
  }
}

async function detectGitHubAvatarIcon(
  repoPath: string,
  connectionId?: string | null,
  upstream?: GitHubRepositoryIdentity | null
): Promise<RepoIcon | null> {
  try {
    // Why: a fork's origin is the personal copy, so prefer the upstream owner.
    const slug = upstream ?? (await getRepoSlug(repoPath, connectionId))
    return slug ? githubAvatarIcon(slug) : null
  } catch {
    return null
  }
}

export async function detectRepoIcon({
  repoPath,
  kind,
  connectionId,
  upstream
}: {
  repoPath: string
  kind: RepoKind
  connectionId?: string | null
  upstream?: GitHubRepositoryIdentity | null
}): Promise<RepoIcon | undefined> {
  try {
    const fsProvider = connectionId ? getSshFilesystemProvider(connectionId) : undefined
    const fileIcon = fsProvider
      ? await detectRemoteRepoPngIcon(repoPath, fsProvider)
      : await detectLocalRepoPngIcon(repoPath)
    if (fileIcon) {
      return fileIcon
    }

    const homepageIcon = fsProvider
      ? await detectRemotePackageHomepageIcon(repoPath, fsProvider)
      : await detectLocalPackageHomepageIcon(repoPath)
    if (homepageIcon) {
      return homepageIcon
    }

    if (kind === 'git') {
      return (await detectGitHubAvatarIcon(repoPath, connectionId, upstream)) ?? undefined
    }
  } catch {
    // Repo creation must not fail because a best-effort icon probe failed.
  }
  return undefined
}

// Why: `upstream: null` is a resolved "not a fork" marker and prevents
// repeated best-effort probes.
export async function detectRepoIconAndUpstream({
  repoPath,
  kind,
  connectionId
}: {
  repoPath: string
  kind: RepoKind
  connectionId?: string | null
}) {
  const upstream = kind === 'git' ? await getRepoUpstream(repoPath, connectionId) : null
  const gitRemoteIdentity =
    kind === 'git' ? await detectGitRemoteIdentity(repoPath, connectionId) : null
  const repoIcon = await detectRepoIcon({ repoPath, kind, connectionId, upstream })
  return {
    ...(repoIcon ? { repoIcon } : {}),
    ...(gitRemoteIdentity ? { gitRemoteIdentity } : {}),
    ...(kind === 'git' ? { upstream: upstream ?? null } : {})
  }
}
