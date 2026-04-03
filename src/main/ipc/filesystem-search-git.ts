import { spawn } from 'child_process'
import { join } from 'path'
import type { SearchOptions, SearchResult, SearchFileResult } from '../../shared/types'

const SEARCH_TIMEOUT_MS = 15000

function normalizeRelativePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}

// Why: esbuild's parser chokes on regex literals containing brace/bracket
// character classes, so we escape special chars with a simple loop instead.
const REGEX_SPECIAL = '.*+?^${}()|[]\\'
function escapeRegexSource(str: string): string {
  let out = ''
  for (let i = 0; i < str.length; i++) {
    out += REGEX_SPECIAL.includes(str[i]) ? `\\${str[i]}` : str[i]
  }
  return out
}

/**
 * Convert a user-facing glob pattern into a git pathspec.
 *
 * Why: rg globs like `*.ts` match at any directory depth, but a bare git
 * pathspec `*.ts` only matches in the repo root. Wrapping with `:(glob)` and
 * prepending `** /` for patterns without a path separator replicates rg's
 * recursive-by-default behaviour.
 */
function toGitGlobPathspec(glob: string, exclude?: boolean): string {
  const needsRecursive = !glob.includes('/')
  const pattern = needsRecursive ? `**/${glob}` : glob
  return exclude ? `:(exclude,glob)${pattern}` : `:(glob)${pattern}`
}

/**
 * Fallback text search using git grep. Used when rg is not available.
 *
 * Why: On Linux, rg may not be installed or may not be in PATH when the app
 * is launched from a desktop entry (which inherits a minimal system PATH).
 * git grep is always available since this is a git-focused app.
 */
export function searchWithGitGrep(
  rootPath: string,
  args: SearchOptions,
  maxResults: number
): Promise<SearchResult> {
  return new Promise((resolve) => {
    // Why: --untracked searches untracked (but not ignored) files in addition
    // to tracked ones, matching rg's default behaviour of respecting gitignore.
    // Why: -I skips binary files (mirrors rg's default). --null uses \0 as
    // the filename delimiter so filenames with colons parse unambiguously.
    // --no-recurse-submodules is needed because users may have
    // submodule.recurse=true in their git config, which conflicts with
    // --untracked and would cause git grep to fail.
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

    if (!args.caseSensitive) {
      gitArgs.push('-i')
    }
    if (args.wholeWord) {
      gitArgs.push('-w')
    }
    if (!args.useRegex) {
      gitArgs.push('--fixed-strings')
    } else {
      gitArgs.push('--extended-regexp')
    }

    gitArgs.push('-e', args.query, '--')

    let hasPathspecs = false
    if (args.includePattern) {
      for (const pat of args.includePattern
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        gitArgs.push(toGitGlobPathspec(pat))
        hasPathspecs = true
      }
    }
    if (args.excludePattern) {
      for (const pat of args.excludePattern
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        gitArgs.push(toGitGlobPathspec(pat, true))
        hasPathspecs = true
      }
    }
    // Why: when no include patterns are given, git grep needs a pathspec to
    // search the working tree. '.' means "everything under cwd".
    if (!hasPathspecs) {
      gitArgs.push('.')
    }

    const fileMap = new Map<string, SearchFileResult>()
    let totalMatches = 0
    let truncated = false
    let stdoutBuffer = ''
    let done = false

    // Build a JS regex to locate all submatch positions within each matched
    // line. git grep only reports the first match per line; we need byte
    // offsets and lengths for every occurrence to populate SearchMatch[].
    let pattern = args.useRegex ? args.query : escapeRegexSource(args.query)
    if (args.wholeWord) {
      pattern = `\\b${pattern}\\b`
    }
    const matchRegex = new RegExp(pattern, `g${args.caseSensitive ? '' : 'i'}`)

    const resolveOnce = (): void => {
      if (done) {
        return
      }
      done = true
      clearTimeout(killTimeout)
      resolve({
        files: Array.from(fileMap.values()),
        totalMatches,
        truncated
      })
    }

    const processLine = (line: string): void => {
      if (!line || totalMatches >= maxResults) {
        return
      }

      // Why: with --null -n the output format is filename\0linenum:content.
      // The null byte separates the filename unambiguously (colons in
      // filenames would otherwise break parsing).
      const nullIdx = line.indexOf('\0')
      if (nullIdx === -1) {
        return
      }
      const relPath = normalizeRelativePath(line.substring(0, nullIdx))
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

      // Find all match positions within the line
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
        if (totalMatches >= maxResults) {
          truncated = true
          child.kill()
          break
        }
        // Prevent infinite loop on zero-length regex matches
        if (m[0].length === 0) {
          matchRegex.lastIndex++
        }
      }
    }

    const child = spawn('git', gitArgs, {
      cwd: rootPath,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const l of lines) {
        processLine(l)
      }
    })
    child.stderr.on('data', () => {
      /* drain */
    })
    child.once('error', () => {
      resolveOnce()
    })
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
