/**
 * Pure helpers and child-process search utilities extracted from fs-handler.ts.
 *
 * Why: oxlint max-lines requires .ts files to stay under 300 lines.
 * These functions depend only on their arguments (plus `rg` being on PATH),
 * so they are straightforward to test independently.
 */
import { spawn, execFile } from 'child_process'
import { open } from 'fs/promises'
import {
  buildRgArgs,
  createAccumulator,
  finalize,
  ingestRgJsonLine,
  SEARCH_TIMEOUT_MS as SHARED_SEARCH_TIMEOUT_MS
} from '../shared/text-search'
import type { SearchResult as SharedSearchResult } from '../shared/types'

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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
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
  return new Promise((resolve) => {
    const rgArgs = buildRgArgs(query, rootPath, opts)
    const acc = createAccumulator()
    let buffer = ''
    let resolved = false

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
      resolve(finalize(acc))
    }

    function processLine(line: string): void {
      const verdict = ingestRgJsonLine(line, rootPath, acc, opts.maxResults)
      if (verdict === 'stop') {
        child.kill()
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
      resolveOnce()
    }

    function handleClose(): void {
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
      child.kill()
      resolveOnce()
    }, SEARCH_TIMEOUT_MS)
  })
}

// ─── rg availability check ──────────────────────────────────────────

// Why no cache: `rg --version` is a sub-10ms local spawn, and caching the
// result caused a footgun — a negative cache persisted across rg installs
// (forcing a relay restart), while a positive cache could mask an rg that
// was uninstalled or broken mid-session. The `settled` flag below closes
// the original race between 'error' and 'close' that the cache was added
// to paper over, so re-checking per call is both simpler and safer.
const RG_AVAILABILITY_TIMEOUT_MS = 5000

export function checkRgAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const child = execFile('rg', ['--version'])
    let timeout: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      child.off('error', onError)
      child.off('close', onClose)
    }
    const settle = (available: boolean, options?: { kill?: boolean }): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (options?.kill) {
        child.kill()
      }
      resolve(available)
    }
    const onError = (): void => settle(false)
    const onClose = (code: number | null): void => settle(code === 0)

    child.once('error', onError)
    child.once('close', onClose)
    timeout = setTimeout(() => settle(false, { kill: true }), RG_AVAILABILITY_TIMEOUT_MS)
    if (typeof timeout.unref === 'function') {
      timeout.unref()
    }
  })
}

// Moved to fs-handler-list-files.ts to keep this file under 300 lines (oxlint)
export { listFilesWithRg, LIST_FILES_TIMEOUT_MS } from './fs-handler-list-files'
