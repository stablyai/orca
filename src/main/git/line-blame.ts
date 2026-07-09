import type { GitLineBlameResult } from '../../shared/types'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

// git's sentinel sha for a line that isn't committed yet (local/unsaved change).
const UNCOMMITTED_SHA = '0'.repeat(40)

// Cap the blame so a slow `git blame` (huge file/history) can't stall
// cursor-driven updates or leave a child process hanging.
const BLAME_TIMEOUT_MS = 5000

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
      ['blame', '--porcelain', '-L', `${line1Indexed},${line1Indexed}`, '--', repoRelativeFilePath],
      { ...gitOptionsForWorktree(worktreePath, options), timeout: BLAME_TIMEOUT_MS }
    )
    return parseBlamePorcelain(stdout)
  } catch {
    return null
  }
}
