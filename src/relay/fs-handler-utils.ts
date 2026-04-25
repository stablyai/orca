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
// Why: previewable binaries (PDFs, images) are rendered by the viewer as
// base64 blobs, not parsed as text — 5MB is tight for real-world PDFs, and
// raising this cap only affects binary preview, not text/search paths.
// Why 10MB (not 50MB like the local main-process cap): the SSH relay ships
// every JSON-RPC response in a single framed message capped at
// MAX_MESSAGE_SIZE = 16MB (see src/relay/protocol.ts and
// src/main/ssh/relay-protocol.ts). A file here is sent as base64 inside JSON,
// so 10MB on disk → ~13.3MB base64 → ~13.4MB framed payload, leaving headroom
// under the 16MB frame cap. Raising this cap without first landing streaming
// reads would cause the encoder to throw "Message too large" and the decoder
// to discard oversized frames for borderline files. The proper path to a
// higher remote cap is streaming fs.readFile over the relay, not bumping
// MAX_MESSAGE_SIZE (which would introduce head-of-line blocking on the mux).
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

let rgAvailableCache: boolean | null = null

export function checkRgAvailable(): Promise<boolean> {
  if (rgAvailableCache !== null) {
    return Promise.resolve(rgAvailableCache)
  }
  return new Promise((resolve) => {
    const child = execFile('rg', ['--version'])
    child.once('error', () => {
      rgAvailableCache = false
      resolve(false)
    })
    child.once('close', (code) => {
      if (rgAvailableCache !== null) {
        return
      }
      rgAvailableCache = code === 0
      resolve(rgAvailableCache)
    })
  })
}

// ─── rg-based file listing ───────────────────────────────────────────

/**
 * List all non-ignored files under `rootPath` using ripgrep's `--files` mode.
 * Returns relative POSIX paths.
 */
export function listFilesWithRg(rootPath: string): Promise<string[]> {
  return new Promise((resolve) => {
    const files: string[] = []
    let buffer = ''
    let done = false

    const finish = () => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      resolve(files)
    }

    const child = execFile(
      'rg',
      ['--files', '--hidden', '--glob', '!**/node_modules', '--glob', '!**/.git', rootPath],
      { maxBuffer: 50 * 1024 * 1024 }
    )

    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line) {
          continue
        }
        const relPath = relative(rootPath, line).replace(/\\/g, '/')
        if (!relPath.startsWith('..')) {
          files.push(relPath)
        }
      }
    })
    child.stderr!.on('data', () => {
      /* drain */
    })
    child.once('error', () => finish())
    child.once('close', () => {
      if (buffer) {
        const relPath = relative(rootPath, buffer.trim()).replace(/\\/g, '/')
        if (relPath && !relPath.startsWith('..')) {
          files.push(relPath)
        }
      }
      finish()
    })
    const timer = setTimeout(() => child.kill(), 10_000)
  })
}
