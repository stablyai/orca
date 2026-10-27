import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FileDocument } from '../../shared/filesystem-entry-types'
import { ensureDefaultFloatingWorkspacePath } from '../ipc/floating-workspace-directory'
import {
  fileDocumentFromFilePath,
  isMarkdownDocumentName
} from '../../shared/markdown-document-paths'

export function isOsOpenedDocumentName(name: string): boolean {
  const extension = path.extname(name).toLowerCase()
  return isMarkdownDocumentName(name) || extension === '.csv' || extension === '.tsv'
}

// Bound runaway argv so paths cannot occupy memory for the entire session.
export const MAX_PENDING_OS_OPENED_DOCUMENTS = 32

/** Accept file URLs defensively because Linux %U permits URLs, though GLib currently decodes local ones before spawn. macOS/Windows provide paths. */
function localPathFromArgument(argument: string, platform: NodeJS.Platform): string | null {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (argument.startsWith('file://')) {
    try {
      // Explicit target-platform decoding keeps host-independent behavior and restores Windows UNC paths.
      return fileURLToPath(argument, { windows: platform === 'win32' })
    } catch {
      return null
    }
  }
  return pathApi.isAbsolute(argument) ? argument : null
}

/** Accept absolute supported documents; entrypoints fail extension checks and relative paths have no meaningful second-instance cwd. */
export function documentPathsFromArguments(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const seen = new Set<string>()
  const paths: string[] = []
  for (const rawArgument of argv) {
    if (!rawArgument || rawArgument.startsWith('-')) {
      continue
    }
    const argument = localPathFromArgument(rawArgument, platform)
    if (!argument || !isOsOpenedDocumentName(argument)) {
      continue
    }
    const normalized = pathApi.normalize(argument)
    // Windows drive/8.3 casing can change across shell round trips; dedupe case-insensitively.
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    paths.push(normalized)
  }
  return paths
}

/** Share one push/pull buffer so cold-start Open With survives until the renderer listener mounts. */
export class OsOpenedDocumentState {
  private pending: string[] = []

  /** True means argv contained a supported document. */
  capture(argv: readonly string[], publish?: () => void): boolean {
    return this.add(documentPathsFromArguments(argv), publish)
  }

  /** True means at least one supported document, even if already queued. */
  captureFilePaths(filePaths: readonly string[], publish?: () => void): boolean {
    return this.add(documentPathsFromArguments(filePaths), publish)
  }

  consume(): string[] {
    const pending = this.pending
    this.pending = []
    return pending
  }

  /** Puts an undelivered batch back at the front so the next renderer still receives it. */
  restore(filePaths: readonly string[]): void {
    this.pending = [...filePaths, ...this.pending].slice(0, MAX_PENDING_OS_OPENED_DOCUMENTS)
  }

  private add(filePaths: readonly string[], publish?: () => void): boolean {
    if (filePaths.length === 0) {
      return false
    }
    const merged = [...this.pending]
    let index = 0
    for (; index < filePaths.length; index++) {
      if (merged.length >= MAX_PENDING_OS_OPENED_DOCUMENTS) {
        break
      }
      const filePath = filePaths[index]!
      if (!merged.includes(filePath)) {
        merged.push(filePath)
      }
    }
    if (index < filePaths.length) {
      // Report dropped selections; explicitly requested files must not disappear without evidence.
      console.warn(
        `[os-open] Dropped ${filePaths.length - index} of ${filePaths.length} OS-opened documents; the pending queue is capped at ${MAX_PENDING_OS_OPENED_DOCUMENTS}.`
      )
    }
    this.pending = merged.slice(0, MAX_PENDING_OS_OPENED_DOCUMENTS)
    publish?.()
    return true
  }
}

/** Use the floating workspace file-picker shape so OS-opened files retain explicit user-file access. */
export async function resolveOsOpenedDocuments(
  filePaths: readonly string[]
): Promise<FileDocument[]> {
  const supportedPaths = documentPathsFromArguments(filePaths).slice(
    0,
    MAX_PENDING_OS_OPENED_DOCUMENTS
  )
  if (supportedPaths.length === 0) {
    return []
  }
  const floatingRoot = await ensureDefaultFloatingWorkspacePath()
  const documents: FileDocument[] = []
  for (const filePath of supportedPaths) {
    try {
      // Shell paths can name directories or files deleted before resolution; only open actual files.
      if (!(await stat(filePath)).isFile()) {
        continue
      }
    } catch {
      continue
    }
    documents.push(
      fileDocumentFromFilePath(floatingRoot, filePath, {
        outsideRootRelativePath: 'basename'
      })
    )
  }
  return documents
}
