/**
 * Pure helpers and child-process search utilities extracted from fs-handler.ts.
 *
 * Why: oxlint max-lines requires .ts files to stay under 300 lines.
 * These functions depend only on their arguments (plus `rg` being on PATH),
 * so they are straightforward to test independently.
 */
import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import {
  buildRgArgs,
  createAccumulator,
  finalize,
  ingestRgJsonLine,
  SEARCH_TIMEOUT_MS as SHARED_SEARCH_TIMEOUT_MS
} from '../shared/text-search'
import { IMAGE_FILE_MIME_TYPES } from '../shared/image-file-extensions'
import type { SearchResult as SharedSearchResult } from '../shared/code-search-types'
import {
  absorbPendingRipgrepSpawnError,
  isRipgrepUnavailableAfterLaunchFailure,
  isRipgrepUnavailableExit,
  killSpawnedRipgrepProcess,
  RipgrepUnavailableError
} from '../shared/ripgrep-process-availability'

// ─── Constants ───────────────────────────────────────────────────────

// Why: remote reads still travel through bounded JSON-RPC frames, but matching
// the old 5MB search cap would block common JSON/log files before Monaco's
// large-file optimizations can handle them.
export const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024
// Why: matches the local cap (src/main/ipc/filesystem.ts MAX_PREVIEWABLE_BINARY_SIZE).
// Reads above the legacy 16MB single-frame budget go through fs.readFileStream,
// which chunks at STREAM_CHUNK_SIZE; see docs/relay-file-stream-design.md.
export const MAX_PREVIEWABLE_BINARY_SIZE = 50 * 1024 * 1024
export const BINARY_PROBE_BYTES = 8192
export const SEARCH_TIMEOUT_MS = SHARED_SEARCH_TIMEOUT_MS
export const DEFAULT_MAX_RESULTS = 2000

export const IMAGE_MIME_TYPES: Record<string, string> = {
  ...IMAGE_FILE_MIME_TYPES,
  '.pdf': 'application/pdf'
}

// ─── Binary detection ────────────────────────────────────────────────

export function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192)
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}

export async function isBinaryFilePrefix(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r')
  try {
    const probe = Buffer.alloc(BINARY_PROBE_BYTES)
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    return isBinaryBuffer(probe.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

// ─── Search types ────────────────────────────────────────────────────

export type SearchOptions = {
  caseSensitive?: boolean
  wholeWord?: boolean
  useRegex?: boolean
  includePattern?: string
  excludePattern?: string
  maxResults: number
}

export type SearchResult = SharedSearchResult

// ─── rg-based search ─────────────────────────────────────────────────

/**
 * Run ripgrep (`rg`) with JSON output to collect text matches.
 *
 * Why `spawn` and not `execFile`: `execFile` buffers stdout internally and
 * kills the child when `maxBuffer` is exceeded, even when 'data' listeners
 * are attached. Under rg's verbose `--json` output, a 50MB buffer fills
 * well before the match cap in large folders, and `execFile`'s silent
 * buffer-exceeded error resolves the result as `truncated: false` despite
 * dropping matches. See docs/design/share-text-search.md.
 */
export function searchWithRg(
  rootPath: string,
  query: string,
  opts: SearchOptions
): Promise<SearchResult> {
  return new Promise((resolve, reject) => {
    const rgArgs = buildRgArgs(query, rootPath, opts)
    const acc = createAccumulator()
    let buffer = ''
    let resolved = false
    let processErrorObserved = false
    let unavailableExitObserved = false
    let launchFailureCheck: Promise<void> | null = null

    // Why: spawn can throw synchronously on invalid options (e.g. bad cwd),
    // which would leak out of the `new Promise` executor and leave the
    // promise forever pending. Treat a synchronous throw as a clean
    // "no results" fallback, the same way an async 'error' event is handled.
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('rg', rgArgs, {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolve(finalize(acc))
      return
    }

    let killTimeout: ReturnType<typeof setTimeout>

    function resolveOnce(): void {
      if (resolved) {
        return
      }
      resolved = true
      clearTimeout(killTimeout)
      // Why: child.kill() is advisory over SSH; detach listeners if the
      // process ignores timeout kill so old searches cannot retain closures.
      child.stdout!.off('data', handleStdoutData)
      child.stderr!.off('data', handleStderrData)
      child.off('error', handleError)
      child.off('close', handleClose)
      absorbPendingRipgrepSpawnError(child, {
        errorObserved: processErrorObserved,
        unavailableExitObserved
      })
      resolve(finalize(acc))
    }

    function rejectUnavailable(): void {
      if (resolved) {
        return
      }
      resolved = true
      clearTimeout(killTimeout)
      child.stdout!.off('data', handleStdoutData)
      child.stderr!.off('data', handleStderrData)
      child.off('error', handleError)
      child.off('close', handleClose)
      absorbPendingRipgrepSpawnError(child, {
        errorObserved: processErrorObserved,
        unavailableExitObserved
      })
      reject(new RipgrepUnavailableError())
    }

    function settleLaunchFailure(): void {
      if (launchFailureCheck) {
        return
      }
      launchFailureCheck = isRipgrepUnavailableAfterLaunchFailure(rootPath).then((unavailable) => {
        if (unavailable) {
          rejectUnavailable()
        } else {
          resolveOnce()
        }
      })
    }

    function processLine(line: string): void {
      const verdict = ingestRgJsonLine(line, rootPath, acc, opts.maxResults)
      if (verdict === 'stop') {
        killSpawnedRipgrepProcess(child)
      }
    }

    function handleStdoutData(chunk: string): void {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        processLine(line)
      }
    }

    function handleStderrData(): void {
      /* drain */
    }

    function handleError(): void {
      processErrorObserved = true
      if (isRipgrepUnavailableExit(child, null, null)) {
        settleLaunchFailure()
        return
      }
      resolveOnce()
    }

    function handleClose(code: number | null, signal: NodeJS.Signals | null): void {
      if (
        isRipgrepUnavailableExit(child, code, signal, {
          classifyNativeLauncherExit: true
        })
      ) {
        unavailableExitObserved = true
        settleLaunchFailure()
        return
      }
      if (buffer) {
        processLine(buffer)
      }
      resolveOnce()
    }

    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', handleStdoutData)
    child.stderr!.on('data', handleStderrData)
    child.once('error', handleError)
    child.once('close', handleClose)

    killTimeout = setTimeout(() => {
      acc.truncated = true
      killSpawnedRipgrepProcess(child)
      resolveOnce()
    }, SEARCH_TIMEOUT_MS)
  })
}

// Moved to fs-handler-list-files.ts to keep this file under 300 lines (oxlint)
export { listFilesWithRg, LIST_FILES_TIMEOUT_MS } from './fs-handler-list-files'
