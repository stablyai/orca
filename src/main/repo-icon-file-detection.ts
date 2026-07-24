import { stat } from 'node:fs/promises'
import { MAX_REPO_ICON_UPLOAD_BYTES, type RepoIcon } from '../shared/repo-icon'
import { assertRasterImagePreviewWithinLimits } from '../shared/raster-image-preview-limits'
import { readNodeFileWithinLimit } from '../shared/node-bounded-file-reader'
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
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

function isPngBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
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
  const { buffer, stats } = await readNodeFileWithinLimit(filePath, MAX_REPO_ICON_UPLOAD_BYTES)
  if (!stats.isFile() || !isPngBuffer(buffer)) {
    return null
  }
  assertRasterImagePreviewWithinLimits(buffer, 'image/png')
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
  if (result.content.length > Math.ceil((MAX_REPO_ICON_UPLOAD_BYTES * 4) / 3) + 4) {
    return null
  }
  const buffer = Buffer.from(result.content, 'base64')
  if (buffer.byteLength > MAX_REPO_ICON_UPLOAD_BYTES || !isPngBuffer(buffer)) {
    return null
  }
  assertRasterImagePreviewWithinLimits(buffer, 'image/png')
  return {
    type: 'image',
    src: `data:image/png;base64,${buffer.toString('base64')}`,
    source: 'file',
    label: relativePath
  }
}

export async function detectLocalRepoPngIcon(repoPath: string): Promise<RepoIcon | null> {
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
      const sourceRead = await readNodeFileWithinLimit(sourcePath, MAX_REPO_ICON_SOURCE_BYTES)
      if (!sourceRead.stats.isFile()) {
        continue
      }
      const href = extractIconHref(sourceRead.buffer.toString('utf8'))
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

export async function detectRemoteRepoPngIcon(
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
      if (
        result.isBinary ||
        Buffer.byteLength(result.content, 'utf8') > MAX_REPO_ICON_SOURCE_BYTES
      ) {
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
