import { readFile, stat } from 'node:fs/promises'
import { buildImageDataUri } from '../shared/image-data-uri'
import { MAX_REPO_ICON_UPLOAD_BYTES, type RepoIcon } from '../shared/repo-icon'
import type { ExecutionHostFilesystemRoute } from './providers/execution-host-provider-dispatch'
import type { IFilesystemProvider } from './providers/types'
import { iconHrefCandidates } from './repo-icon-href-candidates'
import { joinWorktreeRelativePath } from './runtime/runtime-relative-paths'

// Why: conventional locations only — keep the list short so add-repo stays
// snappy. Support bounded raster images only.
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
const REPO_ICON_FILE_PROBE_CONCURRENCY = 6

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
  // Why: detect the binary format after decoding remote file content.
  const buffer = result.isBinary
    ? Buffer.from(result.content, 'base64')
    : Buffer.from(result.content, 'utf8')
  return repoIconFromImageBuffer(buffer, relativePath)
}

async function detectConventionalImageIcon(
  readIcon: (relativePath: string) => Promise<RepoIcon | null>
): Promise<RepoIcon | null> {
  // Why: SSH stats are network round trips; bounded batches avoid making the
  // expanded candidate list serial without flooding the remote filesystem.
  for (
    let offset = 0;
    offset < REPO_ICON_FILE_CANDIDATES.length;
    offset += REPO_ICON_FILE_PROBE_CONCURRENCY
  ) {
    const batch = REPO_ICON_FILE_CANDIDATES.slice(offset, offset + REPO_ICON_FILE_PROBE_CONCURRENCY)
    const icons = await Promise.all(
      batch.map(async (relativePath) => {
        try {
          return await readIcon(relativePath)
        } catch {
          return null
        }
      })
    )
    const icon = icons.find((candidate): candidate is RepoIcon => candidate !== null)
    if (icon) {
      return icon
    }
  }
  return null
}

async function detectLocalImageIcon(repoPath: string): Promise<RepoIcon | null> {
  const conventionalIcon = await detectConventionalImageIcon((relativePath) =>
    readLocalImageIcon(repoPath, relativePath)
  )
  if (conventionalIcon) {
    return conventionalIcon
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
  const conventionalIcon = await detectConventionalImageIcon((relativePath) =>
    readRemoteImageIcon(repoPath, fsProvider, relativePath)
  )
  if (conventionalIcon) {
    return conventionalIcon
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

/**
 * Takes the resolved host route rather than a `connectionId`, because the incumbent shape spelled
 * "this is local", "this host is unreachable" and "this is a runtime host" all as a falsy id — and
 * only the first of those may read this machine's filesystem.
 */
export function detectRepoFileIcon(
  repoPath: string,
  route: ExecutionHostFilesystemRoute
): Promise<RepoIcon | null> {
  switch (route.kind) {
    case 'local':
      return detectLocalImageIcon(repoPath)
    case 'ssh':
      // A dropped provider fails closed: repoPath lives on the SSH host, so a same-named local
      // path would hand back another repository's icon.
      return route.provider
        ? detectRemoteImageIcon(repoPath, route.provider)
        : Promise.resolve(null)
    case 'runtime':
      // That environment's server holds these files; this process has no route to them.
      return Promise.resolve(null)
  }
}
