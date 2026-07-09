import { readFile, stat } from 'node:fs/promises'
import { buildImageDataUri } from '../shared/image-data-uri'
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
import { detectGitRemoteIdentity } from './repo-git-remote-identity'
import { iconHrefCandidates } from './repo-icon-href-candidates'
import { joinWorktreeRelativePath } from './runtime/runtime-relative-paths'

// Why: conventional locations only — keep the list short so add-repo stays
// snappy. Keep format support to raster images with bounded dimensions.
const REPO_ICON_FILE_STEMS = [
  'favicon',
  'public/favicon',
  'app/favicon',
  'app/icon',
  'src/favicon',
  'src/app/icon',
  'assets/favicon',
  'assets/icon',
  'static/favicon',
  'logo',
  'public/logo',
  // Why: CLI tools and branded assets often use public/icon.* (issue #7902).
  'public/icon',
  // Why: Tauri's default bundle icon path (issue #7902).
  'src-tauri/icons/icon',
  'app-icon',
  'icon'
] as const

const REPO_ICON_FILE_EXTENSIONS = ['.png', '.webp'] as const

export const REPO_ICON_FILE_CANDIDATES = REPO_ICON_FILE_STEMS.flatMap((stem) =>
  REPO_ICON_FILE_EXTENSIONS.map((extension) => `${stem}${extension}`)
)

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

type DetectedImageFormat = {
  mimeType: 'image/png' | 'image/webp'
}

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

function isWebpBuffer(buffer: Buffer): boolean {
  // Why: RIFF container with WEBP fourcc — enough to reject non-images without
  // a full decoder; the sidebar only needs a valid data URL for <img>.
  return (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  )
}

function detectImageFormat(buffer: Buffer): DetectedImageFormat | null {
  if (isPngBuffer(buffer)) {
    return { mimeType: 'image/png' }
  }
  if (isWebpBuffer(buffer)) {
    return { mimeType: 'image/webp' }
  }
  return null
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

function repoIconFromImageBuffer(buffer: Buffer, relativePath: string): RepoIcon | null {
  const format = detectImageFormat(buffer)
  if (!format) {
    return null
  }
  const src = buildImageDataUri(format.mimeType, buffer.toString('base64'))
  if (!src) {
    return null
  }
  return {
    type: 'image',
    src,
    source: 'file',
    label: relativePath
  }
}

async function readLocalImageIcon(
  repoPath: string,
  relativePath: string
): Promise<RepoIcon | null> {
  const filePath = joinWorktreeRelativePath(repoPath, relativePath)
  const info = await stat(filePath)
  if (!info.isFile() || info.size > MAX_REPO_ICON_UPLOAD_BYTES) {
    return null
  }
  const buffer = await readFile(filePath)
  return repoIconFromImageBuffer(buffer, relativePath)
}

async function readRemoteImageIcon(
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
  if (!result.content) {
    return null
  }
  // Why: PNG/WebP are binary; SVG often arrives as text from remote FS
  // providers. Detect format from bytes either way.
  const buffer = result.isBinary
    ? Buffer.from(result.content, 'base64')
    : Buffer.from(result.content, 'utf8')
  return repoIconFromImageBuffer(buffer, relativePath)
}

async function detectLocalImageIcon(repoPath: string): Promise<RepoIcon | null> {
  for (const relativePath of REPO_ICON_FILE_CANDIDATES) {
    try {
      const icon = await readLocalImageIcon(repoPath, relativePath)
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
          const icon = await readLocalImageIcon(repoPath, relativePath)
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

async function detectRemoteImageIcon(
  repoPath: string,
  fsProvider: IFilesystemProvider
): Promise<RepoIcon | null> {
  for (const relativePath of REPO_ICON_FILE_CANDIDATES) {
    try {
      const icon = await readRemoteImageIcon(repoPath, fsProvider, relativePath)
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
          const icon = await readRemoteImageIcon(repoPath, fsProvider, relativePath)
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
      ? await detectRemoteImageIcon(repoPath, fsProvider)
      : await detectLocalImageIcon(repoPath)
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
