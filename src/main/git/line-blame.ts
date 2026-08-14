import type { GitLineBlameResult } from '../../shared/git-line-blame-types'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

// git's sentinel sha for a line that isn't committed yet (local/unsaved change).
const UNCOMMITTED_SHA = '0'.repeat(40)

// Cap the blame so a slow `git blame` (huge file/history) can't stall
// cursor-driven updates or leave a child process hanging.
export const BLAME_TIMEOUT_MS = 5000

// Why a ceiling: porcelain output runs ~2.5-3x the source size, and the git
// runner caps stdout at 10MB. Files past this fall back to per-line blame
// rather than failing.
export const MAX_FILE_BLAME_BYTES = 2 * 1024 * 1024

// Why longer than the per-line cap: one whole-file walk replaces every later
// per-line request for that file, so it is worth waiting a little longer for.
export const FILE_BLAME_TIMEOUT_MS = 15_000

/** Why shared: the local runner and the SSH relay sender must send the exact
 *  argv the relay allowlist permits, so it is spelled once. */
export function buildFileBlameArgs(repoRelativeFilePath: string): string[] {
  return ['blame', '--porcelain', '--', repoRelativeFilePath]
}

/**
 * Parse whole-file `git blame --porcelain` into authorship per 1-indexed line.
 *
 * Why the commit table: porcelain emits a commit's author/summary headers only
 * the first time that commit appears. Every later line for the same commit is
 * just its sha, so the metadata has to be carried forward or those lines come
 * back blank.
 */
export function parseFileBlamePorcelain(stdout: string): Record<number, GitLineBlameResult> {
  const byLine: Record<number, GitLineBlameResult> = {}
  const commits = new Map<string, { author: string; authorTimeMs: number; summary: string }>()
  let current: { sha: string; line: number } | null = null
  for (const raw of stdout.split(/\r?\n/)) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/i.exec(raw)
    if (header) {
      current = { sha: header[1], line: Number(header[2]) }
      if (!commits.has(current.sha)) {
        commits.set(current.sha, { author: '', authorTimeMs: Number.NaN, summary: '' })
      }
      continue
    }
    if (!current) {
      continue
    }
    const commit = commits.get(current.sha)
    if (commit) {
      if (raw.startsWith('author ')) {
        commit.author = raw.slice('author '.length)
      } else if (raw.startsWith('author-time ')) {
        commit.authorTimeMs = Number(raw.slice('author-time '.length)) * 1000
      } else if (raw.startsWith('summary ')) {
        commit.summary = raw.slice('summary '.length)
      }
    }
    // A tab-prefixed line is the source text, which closes this line's entry.
    if (raw.startsWith('\t')) {
      const meta = commits.get(current.sha)
      byLine[current.line] = {
        sha: current.sha,
        author: meta?.author ?? '',
        authorTimeMs: meta?.authorTimeMs ?? Number.NaN,
        summary: meta?.summary ?? '',
        isUncommitted: current.sha === UNCOMMITTED_SHA
      }
      current = null
    }
  }
  return byLine
}

export function buildLineBlameArgs(line1Indexed: number, repoRelativeFilePath: string): string[] {
  return [
    'blame',
    '--porcelain',
    '-L',
    `${line1Indexed},${line1Indexed}`,
    '--',
    repoRelativeFilePath
  ]
}

// Parse `git blame --porcelain` output for a single line. The first token of the
// first line is the commit sha; subsequent "key value" header lines carry the
// author / author-mail / author-time / summary for that commit.
export function parseBlamePorcelain(stdout: string): GitLineBlameResult | null {
  const text = stdout.trimStart()
  if (!text) {
    return null
  }
  // Split on CRLF too so a Windows/relay-normalized stream doesn't leave a stray
  // '\r' on author/summary values.
  const lines = text.split(/\r?\n/)
  const sha = lines[0]?.split(' ')[0] ?? ''
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    return null
  }
  let author = ''
  // NaN (not 0) when author-time is absent/garbage so the caller can hide the
  // date instead of rendering a bogus 1970 timestamp.
  let authorTimeMs = Number.NaN
  let summary = ''
  for (const line of lines) {
    if (line.startsWith('author ')) {
      author = line.slice('author '.length)
    } else if (line.startsWith('author-time ')) {
      authorTimeMs = Number(line.slice('author-time '.length)) * 1000
    } else if (line.startsWith('summary ')) {
      summary = line.slice('summary '.length)
    }
  }
  return { sha, author, authorTimeMs, summary, isUncommitted: sha === UNCOMMITTED_SHA }
}

// Blame a single 1-indexed line of a repo-relative file. Returns null when there
// is nothing to blame (untracked file, out-of-range line, or a git failure) so
// the caller can simply show no authorship instead of surfacing an error.
export async function getLineBlame(
  worktreePath: string,
  repoRelativeFilePath: string,
  line1Indexed: number,
  options: GitRuntimeOptions = {}
): Promise<GitLineBlameResult | null> {
  if (!Number.isInteger(line1Indexed) || line1Indexed < 1) {
    return null
  }
  try {
    const { stdout } = await gitExecFileAsync(
      buildLineBlameArgs(line1Indexed, repoRelativeFilePath),
      { ...gitOptionsForWorktree(worktreePath, options), timeout: BLAME_TIMEOUT_MS }
    )
    return parseBlamePorcelain(stdout)
  } catch {
    return null
  }
}

/**
 * Authorship for every line of a file, in one `git blame` walk.
 *
 * Why whole-file: `-L` does not make blame cheaper — git walks the same history
 * and then discards all but the requested line — so per-line blame pays the full
 * cost on every cursor move. One walk answers every line for the price of one.
 *
 * Returns null when there is nothing to blame or the file is too big to buffer,
 * so the caller can fall back to per-line.
 */
export async function getFileBlame(
  worktreePath: string,
  repoRelativeFilePath: string,
  options: GitRuntimeOptions = {}
): Promise<Record<number, GitLineBlameResult> | null> {
  try {
    const { stdout } = await gitExecFileAsync(buildFileBlameArgs(repoRelativeFilePath), {
      ...gitOptionsForWorktree(worktreePath, options),
      timeout: FILE_BLAME_TIMEOUT_MS,
      maxBuffer: MAX_FILE_BLAME_BYTES * 4
    })
    const byLine = parseFileBlamePorcelain(stdout)
    return Object.keys(byLine).length > 0 ? byLine : null
  } catch {
    return null
  }
}
