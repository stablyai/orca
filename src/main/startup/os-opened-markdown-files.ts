import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import { authorizeExternalPath } from '../ipc/filesystem-auth'
import { ensureDefaultFloatingWorkspacePath } from '../ipc/floating-workspace-directory'
import { isMarkdownDocumentName, markdownDocumentFromFilePath } from '../ipc/markdown-documents'

// Why: a shell can only ever hand over the files the user selected; anything past this is a
// runaway argv, and buffering it unbounded would pin the paths for the whole session.
export const MAX_PENDING_OS_OPENED_MARKDOWN_FILES = 32

/**
 * Resolves one argv entry to a local absolute path, or null if it is not one.
 *
 * Why file:// is accepted defensively: electron-builder appends the `%U` field code to the
 * generated Linux `Exec=` line, and `%U` is specified as "URLs". GLib turns out to decode a
 * local `file://` URI back to a plain path before spawning (measured on Ubuntu 24.04, via
 * the same `launch_uris` call a file manager makes), so the branch below is not what fires
 * there today — but the spec permits a URI, and a launcher that honours it literally would
 * otherwise be silently dropped. macOS `open-file` and the Windows shell `%1` pass paths.
 */
function localPathFromArgument(argument: string, platform: NodeJS.Platform): string | null {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (argument.startsWith('file://')) {
    try {
      // Why the explicit windows flag: this must decode the same way on any host so the
      // behaviour is testable, and it is what turns `file://server/share` back into a UNC path.
      return fileURLToPath(argument, { windows: platform === 'win32' })
    } catch {
      return null
    }
  }
  return pathApi.isAbsolute(argument) ? argument : null
}

/**
 * Absolute markdown paths an OS "Open With" put on a launch or second-instance argv.
 *
 * Why no executable/asar/dev-entry filtering: none of those argv entries end in a markdown
 * extension, so the extension check already excludes them. Relative entries are dropped
 * because the shell always passes absolute paths and `cwd` is meaningless for a second instance.
 */
export function markdownPathsFromArguments(
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
    if (!argument || !isMarkdownDocumentName(argument)) {
      continue
    }
    const normalized = pathApi.normalize(argument)
    // Why lowercased on win32: the shell round-trips drive letters and 8.3 casing
    // inconsistently, and two spellings of one path must not open two tabs.
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    paths.push(normalized)
  }
  return paths
}

/**
 * Buffers markdown paths the OS handed us until a renderer can receive them.
 *
 * Mirrors SkillShareDeepLinkState: main pushes when a window is already live, and the
 * renderer pulls the same buffer when its listener attaches, so a cold-start "Open With"
 * that lands before mount is not dropped.
 */
export class OsOpenedMarkdownFileState {
  private pending: string[] = []

  /** Returns true when argv carried at least one markdown path. */
  capture(argv: readonly string[], publish?: () => void): boolean {
    return this.add(markdownPathsFromArguments(argv), publish)
  }

  /** Returns true when at least one path was a markdown document. */
  captureFilePaths(filePaths: readonly string[], publish?: () => void): boolean {
    return this.add(markdownPathsFromArguments(filePaths), publish)
  }

  consume(): string[] {
    const pending = this.pending
    this.pending = []
    return pending
  }

  /** Puts an undelivered batch back at the front so the next renderer still receives it. */
  restore(filePaths: readonly string[]): void {
    this.pending = [...filePaths, ...this.pending].slice(0, MAX_PENDING_OS_OPENED_MARKDOWN_FILES)
  }

  private add(filePaths: readonly string[], publish?: () => void): boolean {
    if (filePaths.length === 0) {
      return false
    }
    const merged = [...this.pending]
    for (const filePath of filePaths) {
      if (!merged.includes(filePath)) {
        merged.push(filePath)
      }
    }
    this.pending = merged.slice(0, MAX_PENDING_OS_OPENED_MARKDOWN_FILES)
    publish?.()
    return true
  }
}

/**
 * Turns OS-handed paths into the same `MarkdownDocument` shape the floating workspace's own
 * file picker produces, authorizing each one for the renderer's later read.
 */
export async function resolveOpenedMarkdownDocuments(
  filePaths: readonly string[]
): Promise<MarkdownDocument[]> {
  if (filePaths.length === 0) {
    return []
  }
  const floatingRoot = await ensureDefaultFloatingWorkspacePath()
  const documents: MarkdownDocument[] = []
  for (const filePath of filePaths) {
    try {
      // Why: the shell can hand over a bundle directory named `*.md`, or a path already
      // deleted by the time we resolve. Authorize only something that is really a file.
      if (!(await stat(filePath)).isFile()) {
        continue
      }
    } catch {
      continue
    }
    authorizeExternalPath(filePath)
    documents.push(
      markdownDocumentFromFilePath(floatingRoot, filePath, {
        outsideRootRelativePath: 'basename'
      })
    )
  }
  return documents
}
