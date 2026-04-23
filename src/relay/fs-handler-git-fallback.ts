/**
 * Git-based fallbacks for file listing and text search.
 *
 * Why: the relay depends on ripgrep (rg) for fs.listFiles and fs.search, but
 * rg is not installed on many remote machines. These functions use git ls-files
 * and git grep as universal fallbacks — git is always available since this is
 * a git-focused app.
 */
import { join } from 'path'
import { spawn } from 'child_process'
import { SEARCH_TIMEOUT_MS, type SearchOptions, type SearchResult } from './fs-handler-utils'

// Why: mirrors the local HIDDEN_DIR_BLOCKLIST — tool-generated dirs that
// clutter quick-open results but should never appear in file listings.
const HIDDEN_DIR_BLOCKLIST = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.cache',
  '.stably',
  '.vscode',
  '.idea',
  '.yarn',
  '.pnpm-store',
  '.terraform',
  '.docker',
  '.husky'
])

function shouldIncludePath(path: string): boolean {
  let start = 0
  const len = path.length
  while (start < len) {
    let end = path.indexOf('/', start)
    if (end === -1) {
      end = len
    }
    const segment = path.substring(start, end)
    if (segment === 'node_modules' || HIDDEN_DIR_BLOCKLIST.has(segment)) {
      return false
    }
    start = end + 1
  }
  return true
}

const REGEX_SPECIAL = '.*+?^${}()|[]\\'
function escapeRegexSource(str: string): string {
  let out = ''
  for (let i = 0; i < str.length; i++) {
    out += REGEX_SPECIAL.includes(str[i]) ? `\\${str[i]}` : str[i]
  }
  return out
}

function toGitGlobPathspec(glob: string, exclude?: boolean): string {
  const needsRecursive = !glob.includes('/')
  const pattern = needsRecursive ? `**/${glob}` : glob
  return exclude ? `:(exclude,glob)${pattern}` : `:(glob)${pattern}`
}

/**
 * List files using `git ls-files`. Fallback when rg is not installed.
 */
export function listFilesWithGit(rootPath: string): Promise<string[]> {
  const files = new Set<string>()

  const runGitLsFiles = (args: string[]): Promise<void> => {
    return new Promise((resolve) => {
      let buf = ''
      let done = false
      const finish = (): void => {
        if (done) {
          return
        }
        done = true
        clearTimeout(timer)
        resolve()
      }

      const processLine = (line: string): void => {
        if (line.charCodeAt(line.length - 1) === 13) {
          line = line.substring(0, line.length - 1)
        }
        if (!line) {
          return
        }
        if (shouldIncludePath(line)) {
          files.add(line)
        }
      }

      const child = spawn('git', ['ls-files', ...args], {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout!.setEncoding('utf-8')
      child.stdout!.on('data', (chunk: string) => {
        buf += chunk
        let start = 0
        let idx = buf.indexOf('\n', start)
        while (idx !== -1) {
          processLine(buf.substring(start, idx))
          start = idx + 1
          idx = buf.indexOf('\n', start)
        }
        buf = start < buf.length ? buf.substring(start) : ''
      })
      child.stderr!.on('data', () => {
        /* drain */
      })
      child.once('error', () => finish())
      child.once('close', () => {
        if (buf) {
          processLine(buf)
        }
        finish()
      })
      const timer = setTimeout(() => child.kill(), 10_000)
    })
  }

  return Promise.all([
    runGitLsFiles(['--cached', '--others', '--exclude-standard']),
    runGitLsFiles(['--others', '--', '**/.env*'])
  ]).then(() => Array.from(files))
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

/**
 * Text search using `git grep`. Fallback when rg is not installed.
 */
export function searchWithGitGrep(
  rootPath: string,
  query: string,
  opts: SearchOptions
): Promise<SearchResult> {
  return new Promise((resolve) => {
    const gitArgs: string[] = [
      '-c',
      'submodule.recurse=false',
      'grep',
      '-n',
      '-I',
      '--null',
      '--no-color',
      '--untracked'
    ]

    if (!opts.caseSensitive) {
      gitArgs.push('-i')
    }
    if (opts.wholeWord) {
      gitArgs.push('-w')
    }
    if (!opts.useRegex) {
      gitArgs.push('--fixed-strings')
    } else {
      gitArgs.push('--extended-regexp')
    }

    gitArgs.push('-e', query, '--')

    let hasPathspecs = false
    if (opts.includePattern) {
      for (const pat of opts.includePattern
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        gitArgs.push(toGitGlobPathspec(pat))
        hasPathspecs = true
      }
    }
    if (opts.excludePattern) {
      for (const pat of opts.excludePattern
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        gitArgs.push(toGitGlobPathspec(pat, true))
        hasPathspecs = true
      }
    }
    if (!hasPathspecs) {
      gitArgs.push('.')
    }

    const fileMap = new Map<string, FileResult>()
    let totalMatches = 0
    let truncated = false
    let stdoutBuffer = ''
    let done = false

    let pattern = opts.useRegex ? query : escapeRegexSource(query)
    if (opts.wholeWord) {
      pattern = `\\b${pattern}\\b`
    }
    const matchRegex = new RegExp(pattern, `g${opts.caseSensitive ? '' : 'i'}`)

    const resolveOnce = (): void => {
      if (done) {
        return
      }
      done = true
      clearTimeout(killTimeout)
      resolve({ files: Array.from(fileMap.values()), totalMatches, truncated })
    }

    const processLine = (line: string): void => {
      if (!line || totalMatches >= opts.maxResults) {
        return
      }

      const nullIdx = line.indexOf('\0')
      if (nullIdx === -1) {
        return
      }
      const relPath = line
        .substring(0, nullIdx)
        .replace(/[\\/]+/g, '/')
        .replace(/^\/+/, '')
      const rest = line.substring(nullIdx + 1)
      const colonIdx = rest.indexOf(':')
      if (colonIdx === -1) {
        return
      }

      const lineNum = parseInt(rest.substring(0, colonIdx), 10)
      if (isNaN(lineNum)) {
        return
      }
      const lineContent = rest.substring(colonIdx + 1).replace(/\n$/, '')

      const absPath = join(rootPath, relPath)
      let fileResult = fileMap.get(absPath)
      if (!fileResult) {
        fileResult = { filePath: absPath, relativePath: relPath, matches: [] }
        fileMap.set(absPath, fileResult)
      }

      matchRegex.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = matchRegex.exec(lineContent)) !== null) {
        fileResult.matches.push({
          line: lineNum,
          column: m.index + 1,
          matchLength: m[0].length,
          lineContent
        })
        totalMatches++
        if (totalMatches >= opts.maxResults) {
          truncated = true
          child.kill()
          break
        }
        if (m[0].length === 0) {
          matchRegex.lastIndex++
        }
      }
    }

    const child = spawn('git', gitArgs, {
      cwd: rootPath,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const l of lines) {
        processLine(l)
      }
    })
    child.stderr!.on('data', () => {
      /* drain */
    })
    child.once('error', () => resolveOnce())
    child.once('close', () => {
      if (stdoutBuffer) {
        processLine(stdoutBuffer)
      }
      resolveOnce()
    })

    const killTimeout = setTimeout(() => {
      truncated = true
      child.kill()
    }, SEARCH_TIMEOUT_MS)
  })
}
