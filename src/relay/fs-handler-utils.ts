/**
 * Pure helpers and child-process search utilities extracted from fs-handler.ts.
 *
 * Why: oxlint max-lines requires .ts files to stay under 300 lines.
 * These functions depend only on their arguments (plus `rg` being on PATH),
 * so they are straightforward to test independently.
 */
import { spawn, execFile } from 'child_process'
import {
  buildRgArgs,
  createAccumulator,
  finalize,
  ingestRgJsonLine,
  SEARCH_TIMEOUT_MS as SHARED_SEARCH_TIMEOUT_MS
} from '../shared/text-search'
import type { SearchResult as SharedSearchResult } from '../shared/types'

// ─── Constants ───────────────────────────────────────────────────────

export const MAX_FILE_SIZE = 5 * 1024 * 1024
// 10MB for relayed binaries (base64 → ~13.3MB frame payload at 16MB relay cap)
export const MAX_PREVIEWABLE_BINARY_SIZE = 10 * 1024 * 1024
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

    const resolveOnce = (): void => {
      if (resolved) {
        return
      }
      resolved = true
      clearTimeout(killTimeout)
      resolve(finalize(acc))
    }

    const processLine = (line: string): void => {
      const verdict = ingestRgJsonLine(line, rootPath, acc, opts.maxResults)
      if (verdict === 'stop') {
        child.kill()
      }
    }

    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        processLine(line)
      }
    })
    child.stderr!.on('data', () => {
      /* drain */
    })
    child.once('error', () => resolveOnce())
    child.once('close', () => {
      if (buffer) {
        processLine(buffer)
      }
      resolveOnce()
    })

    const killTimeout = setTimeout(() => {
      acc.truncated = true
      child.kill()
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
export function checkRgAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const child = execFile('rg', ['--version'])
    child.once('error', () => {
      if (settled) {
        return
      }
      settled = true
      resolve(false)
    })
    child.once('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      resolve(code === 0)
    })
  })
}

// Moved to fs-handler-list-files.ts to keep this file under 300 lines (oxlint)
export { listFilesWithRg, LIST_FILES_TIMEOUT_MS } from './fs-handler-list-files'
