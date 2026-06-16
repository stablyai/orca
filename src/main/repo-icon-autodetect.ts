import { readFile, stat } from 'fs/promises'
import type { GitHubRepositoryIdentity, RepoKind } from '../shared/types'
import {
  faviconUrlFromWebsite,
  githubAvatarIcon,
  MAX_REPO_ICON_UPLOAD_BYTES,
  type RepoIcon
} from '../shared/repo-icon'
import { getRepoSlug, getRepoUpstream } from './github/client'
import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider } from './providers/types'
import { iconHrefCandidates } from './repo-icon-href-candidates'
import { joinWorktreeRelativePath } from './runtime/runtime-relative-paths'

const REPO_ICON_FILE_CANDIDATES = [
  'favicon.png',
  'public/favicon.png',
  'app/favicon.png',
  'app/icon.png',
  'src/favicon.png',
  'src/app/icon.png',
  'assets/favicon.png',
  'assets/icon.png',
  'static/favicon.png',
  'logo.png',
  'public/logo.png'
]

const REPO_ICON_SOURCE_FILE_CANDIDATES = [
  'index.html',
  'public/index.html',
  'app/routes/__root.tsx',
  'src/routes/__root.tsx',
  'app/root.tsx',
  'src/root.tsx',
  'src/index.html'
]

// Why: repo icon detection runs while adding repos; declared-icon probing should
// not read large app entrypoints just to find a small favicon href.
const MAX_REPO_ICON_SOURCE_BYTES = 256 * 1024

const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i
const LINK_ICON_OBJECT_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i

const WEBSITE_HOSTS_TO_SKIP = new Set([
  'github.com',
  'www.github.com',
  'gitlab.com',
  'www.gitlab.com',
  'bitbucket.org',
  'www.bitbucket.org'
])

function isPngBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  )
}

function shouldUseWebsiteFavicon(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`)
    return !WEBSITE_HOSTS_TO_SKIP.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function extractIconHref(source: string): string | null {
  return source.match(LINK_ICON_HTML_RE)?.[1] ?? source.match(LINK_ICON_OBJECT_RE)?.[1] ?? null
}

async function readLocalPngIcon(repoPath: string, relativePath: string): Promise<RepoIcon | null> {
  const filePath = joinWorktreeRelativePath(repoPath, relativePath)
  const info = await stat(filePath)
  if (!info.isFile() || info.size > MAX_REPO_ICON_UPLOAD_BYTES) {
    return null
  }
  const buffer = await readFile(filePath)
  if (!isPngBuffer(buffer)) {
    return null
  }
  return {
    type: 'image',
    src: `data:image/png;base64,${buffer.toString('base64')}`,
    source: 'file',
    label: relativePath
  }
}

async function readRemotePngIcon(
  repoPath: string,
  fsProvider: IFilesystemProvider,
  relativePath: string
): Promise<RepoIcon | null> {
  const filePath = joinWorktreeRelativePath(repoPath, relativePath)
  const info = await fsProvider.stat(filePath)
  if (info.type !== 'file' || info.size > MAX_REPO_ICON_UPLOAD_BYTES) {
    return null
  }
  const result = await fsProvider.readFile(filePath)
  if (!result.isBinary || result.mimeType !== 'image/png' || !result.content) {
    return null
  }
  const buffer = Buffer.from(result.content, 'base64')
  if (!isPngBuffer(buffer)) {
    return null
  }
  return {
    type: 'image',
    src: `data:image/png;base64,${buffer.toString('base64')}`,
    source: 'file',
    label: relativePath
  }
}

async function detectLocalPngIcon(repoPath: string): Promise<RepoIcon | null> {
  for (const relativePath of REPO_ICON_FILE_CANDIDATES) {
    try {
      const icon = await readLocalPngIcon(repoPath, relativePath)
      if (icon) {
        return icon
      }
    } catch {
      // Try the next conventional icon path.
    }
  }
  for (const sourceFile of REPO_ICON_SOURCE_FILE_CANDIDATES) {
    try {
      const sourcePath = joinWorktreeRelativePath(repoPath, sourceFile)
      const sourceInfo = await stat(sourcePath)
      if (!sourceInfo.isFile() || sourceInfo.size > MAX_REPO_ICON_SOURCE_BYTES) {
        continue
      }
      const source = await readFile(sourcePath, 'utf8')
      const href = extractIconHref(source)
      if (!href) {
        continue
      }
      for (const relativePath of iconHrefCandidates(href, sourceFile)) {
        try {
          const icon = await readLocalPngIcon(repoPath, relativePath)
          if (icon) {
            return icon
          }
        } catch {
          // Try the next href resolution.
        }
      }
    } catch {
      // Try the next source file.
    }
  }
  return null
}

async function detectRemotePngIcon(
  repoPath: string,
  fsProvider: IFilesystemProvider
): Promise<RepoIcon | null> {
  for (const relativePath of REPO_ICON_FILE_CANDIDATES) {
    try {
      const icon = await readRemotePngIcon(repoPath, fsProvider, relativePath)
      if (icon) {
        return icon
      }
    } catch {
      // Try the next conventional icon path.
    }
  }
  for (const sourceFile of REPO_ICON_SOURCE_FILE_CANDIDATES) {
    try {
      const sourcePath = joinWorktreeRelativePath(repoPath, sourceFile)
      const sourceInfo = await fsProvider.stat(sourcePath)
      if (sourceInfo.type !== 'file' || sourceInfo.size > MAX_REPO_ICON_SOURCE_BYTES) {
        continue
      }
      const result = await fsProvider.readFile(sourcePath)
      if (result.isBinary) {
        continue
      }
      const href = extractIconHref(result.content)
      if (!href) {
        continue
      }
      for (const relativePath of iconHrefCandidates(href, sourceFile)) {
        try {
          const icon = await readRemotePngIcon(repoPath, fsProvider, relativePath)
          if (icon) {
            return icon
          }
        } catch {
          // Try the next href resolution.
        }
      }
    } catch {
      // Try the next source file.
    }
  }
  return null
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
    return packageHomepageIcon(JSON.parse(await readFile(packageJsonPath, 'utf8')))
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
      ? await detectRemotePngIcon(repoPath, fsProvider)
      : await detectLocalPngIcon(repoPath)
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

/**
 * Detect a repo's icon and its fork upstream together. The upstream is resolved
 * once and reused for the avatar so a fork shows the upstream owner's avatar.
 * Returns a spread-ready slice of `Repo`. For git repos, `upstream: null`
 * is a resolved "not a fork" marker and prevents repeated best-effort probes.
 */
export async function detectRepoIconAndUpstream({
  repoPath,
  kind,
  connectionId
}: {
  repoPath: string
  kind: RepoKind
  connectionId?: string | null
}): Promise<{ repoIcon?: RepoIcon; upstream?: GitHubRepositoryIdentity | null }> {
  const upstream = kind === 'git' ? await getRepoUpstream(repoPath, connectionId) : null
  const repoIcon = await detectRepoIcon({ repoPath, kind, connectionId, upstream })
  return {
    ...(repoIcon ? { repoIcon } : {}),
    ...(kind === 'git' ? { upstream: upstream ?? null } : {})
  }
}
