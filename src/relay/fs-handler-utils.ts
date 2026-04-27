/**
 * Pure helpers and child-process search utilities extracted from fs-handler.ts.
 *
 * Why: oxlint max-lines requires .ts files to stay under 300 lines.
 * These functions depend only on their arguments (plus `rg` being on PATH),
 * so they are straightforward to test independently.
 */
import { relative } from 'path'
import { execFile, type ChildProcess } from 'child_process'

// ─── Constants ───────────────────────────────────────────────────────

export const MAX_FILE_SIZE = 5 * 1024 * 1024
// 10MB for relayed binaries (base64 → ~13.3MB frame payload at 16MB relay cap)
export const MAX_PREVIEWABLE_BINARY_SIZE = 10 * 1024 * 1024
export const SEARCH_TIMEOUT_MS = 15_000
export const MAX_MATCHES_PER_FILE = 100
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

type FileResult = {
  filePath: string
  relativePath: string
  matches: {
    line: number
    column: number
    matchLength: number
    lineContent: string
  }[]
}

export type SearchResult = {
  files: FileResult[]
  totalMatches: number
  truncated: boolean
}

// ─── rg-based search ─────────────────────────────────────────────────

/**
 * Run ripgrep (`rg`) with JSON output to collect text matches.
 * Returns a structured result that the relay can send to the client.
 */
export function searchWithRg(
  rootPath: string,
  query: string,
  opts: SearchOptions
): Promise<SearchResult> {
  return new Promise((resolve) => {
    const rgArgs = [
      '--json',
      '--hidden',
      '--glob',
      '!.git',
      '--max-count',
      String(MAX_MATCHES_PER_FILE),
      '--max-filesize',
      `${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}M`
    ]

    if (!opts.caseSensitive) {
      rgArgs.push('--ignore-case')
    }
    if (opts.wholeWord) {
      rgArgs.push('--word-regexp')
    }
    if (!opts.useRegex) {
      rgArgs.push('--fixed-strings')
    }
    if (opts.includePattern) {
      for (const p of opts.includePattern
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        rgArgs.push('--glob', p)
      }
    }
    if (opts.excludePattern) {
      for (const p of opts.excludePattern
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        rgArgs.push('--glob', `!${p}`)
      }
    }
    rgArgs.push('--', query, rootPath)

    const fileMap = new Map<string, FileResult>()
    let totalMatches = 0
    let truncated = false
    let buffer = ''
    let resolved = false
    let child: ChildProcess | null = null

    const resolveOnce = () => {
      if (resolved) {
        return
      }
      resolved = true
      clearTimeout(killTimeout)
      resolve({ files: Array.from(fileMap.values()), totalMatches, truncated })
    }

    try {
      child = execFile('rg', rgArgs, { maxBuffer: 50 * 1024 * 1024 })
    } catch {
      resolve({ files: [], totalMatches: 0, truncated: false })
      return
    }

    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line || totalMatches >= opts.maxResults) {
          continue
        }
        try {
          const msg = JSON.parse(line)
          if (msg.type !== 'match') {
            continue
          }
          const data = msg.data
          const absPath = data.path.text as string
          const relPath = relative(rootPath, absPath).replace(/\\/g, '/')

          let fileResult = fileMap.get(absPath)
          if (!fileResult) {
            fileResult = { filePath: absPath, relativePath: relPath, matches: [] }
            fileMap.set(absPath, fileResult)
          }
          for (const sub of data.submatches) {
            fileResult.matches.push({
              line: data.line_number,
              column: sub.start + 1,
              matchLength: sub.end - sub.start,
              lineContent: data.lines.text.replace(/\n$/, '')
            })
            totalMatches++
            if (totalMatches >= opts.maxResults) {
              truncated = true
              child?.kill()
              break
            }
          }
        } catch {
          /* skip malformed */
        }
      }
    })
    child.stderr!.on('data', () => {
      /* drain */
    })
    child.once('error', () => resolveOnce())
    child.once('close', () => {
      if (buffer && totalMatches < opts.maxResults) {
        try {
          const msg = JSON.parse(buffer)
          if (msg.type === 'match') {
            const data = msg.data
            const absPath = data.path.text as string
            const relPath = relative(rootPath, absPath).replace(/\\/g, '/')

            let fileResult = fileMap.get(absPath)
            if (!fileResult) {
              fileResult = { filePath: absPath, relativePath: relPath, matches: [] }
              fileMap.set(absPath, fileResult)
            }
            for (const sub of data.submatches) {
              fileResult.matches.push({
                line: data.line_number,
                column: sub.start + 1,
                matchLength: sub.end - sub.start,
                lineContent: data.lines.text.replace(/\n$/, '')
              })
              totalMatches++
              if (totalMatches >= opts.maxResults) {
                truncated = true
                break
              }
            }
          }
        } catch {
          /* skip malformed */
        }
      }
      resolveOnce()
    })

    const killTimeout = setTimeout(() => {
      truncated = true
      child?.kill()
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
