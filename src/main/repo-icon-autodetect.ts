import { readFile, stat } from 'fs/promises'
import type { RepoKind } from '../shared/types'
import {
  faviconUrlFromWebsite,
  MAX_REPO_ICON_UPLOAD_BYTES,
  type RepoIcon
} from '../shared/repo-icon'
import { getRepoSlug } from './github/client'
import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider } from './providers/types'
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

function normalizeIconHrefPath(href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('//') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return null
  }

  const pathOnly = (trimmed.split(/[?#]/)[0] ?? '').replace(/^\/+/, '').replace(/\\/g, '/')
  const parts = pathOnly.split('/').filter((part) => part && part !== '.')
  // Why: declared icon hrefs are repo content. Never let a best-effort icon
  // probe resolve outside the worktree through `../` path segments.
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    return null
  }
  return parts.join('/')
}

function iconHrefCandidates(href: string): string[] {
  const clean = normalizeIconHrefPath(href)
  return clean ? [`public/${clean}`, clean] : []
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
      const source = await readFile(joinWorktreeRelativePath(repoPath, sourceFile), 'utf8')
      const href = extractIconHref(source)
      if (!href) {
        continue
      }
      for (const relativePath of iconHrefCandidates(href)) {
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
      const result = await fsProvider.readFile(joinWorktreeRelativePath(repoPath, sourceFile))
      if (result.isBinary) {
        continue
      }
      const href = extractIconHref(result.content)
      if (!href) {
        continue
      }
      for (const relativePath of iconHrefCandidates(href)) {
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
  connectionId?: string | null
): Promise<RepoIcon | null> {
  try {
    const slug = await getRepoSlug(repoPath, connectionId)
    return slug
      ? {
          type: 'image',
          src: `https://github.com/${encodeURIComponent(slug.owner)}.png?size=64`,
          source: 'github',
          label: `${slug.owner}/${slug.repo}`
        }
      : null
  } catch {
    return null
  }
}

export async function detectRepoIcon({
  repoPath,
  kind,
  connectionId
}: {
  repoPath: string
  kind: RepoKind
  connectionId?: string | null
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
      return (await detectGitHubAvatarIcon(repoPath, connectionId)) ?? undefined
    }
  } catch {
    // Repo creation must not fail because a best-effort icon probe failed.
  }
  return undefined
}
