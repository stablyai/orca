import { readFile, stat } from 'node:fs/promises'
import { buildImageDataUri } from '../shared/image-data-uri'
import { MAX_REPO_ICON_UPLOAD_BYTES, type RepoIcon } from '../shared/repo-icon'
import type { ExecutionHostFilesystemRoute } from './providers/execution-host-provider-dispatch'
import { detectImageFileSignature } from './image-file-signature'
import { extractIconHref } from './repo-icon-source-href'
import { iconHrefCandidates } from './repo-icon-href-candidates'
import { joinWorktreeRelativePath } from './runtime/runtime-relative-paths'

// Keep add-repo probes limited to conventional paths.
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
  'public/icon',
  // Tauri bundle icon.
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

// Avoid reading large entrypoints just to find a favicon href.
const MAX_REPO_ICON_SOURCE_BYTES = 256 * 1024

type DetectedImageFormat = {
  mimeType: 'image/png' | 'image/webp'
}

function detectImageFormat(buffer: Buffer): DetectedImageFormat | null {
  const signature = detectImageFileSignature(buffer)
  if (signature?.mimeType === 'image/png' || signature?.mimeType === 'image/webp') {
    return { mimeType: signature.mimeType }
  }
  return null
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

async function detectConventionalImageIcon(
  readIcon: (relativePath: string) => Promise<RepoIcon | null>
): Promise<RepoIcon | null> {
  // Probe slow WSL/network mounts concurrently without flooding the filesystem.
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
          // Missing or unreadable icon; try the next href.
        }
      }
    } catch {
      // Missing or unreadable source; try the next file.
    }
  }
  return null
}

export function detectRepoFileIcon(
  repoPath: string,
  route: ExecutionHostFilesystemRoute
): Promise<RepoIcon | null> {
  switch (route.kind) {
    case 'local':
      return detectLocalImageIcon(repoPath)
    case 'ssh':
    case 'runtime':
      // Remote paths must never resolve to this machine's files.
      return Promise.resolve(null)
  }
}
