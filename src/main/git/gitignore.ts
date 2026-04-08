import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const GITIGNORE_NAME = '.gitignore'

// Why these four and only these four: git recognizes many more patterns that
// could effectively ignore `.worktrees/` at the repo root (e.g. `**/.worktrees`,
// globs that happen to match), but implementing the full ignore-rule grammar
// is explicitly a non-goal (see design doc). These four are the canonical
// forms users write by hand; everything else falls through to the prompt.
const ROOT_WORKTREES_PATTERNS = new Set([
  '.worktrees',
  '.worktrees/',
  '/.worktrees',
  '/.worktrees/'
])

export function isWorktreesDirIgnoredByGitignore(content: string | null): boolean {
  if (content == null) {
    return false
  }
  // Why no .trim() per line: git treats leading whitespace as part of the
  // pattern (so `\t.worktrees/` is a literal filename, not an ignored dir),
  // and trailing spaces are significant unless escaped. A trim() would
  // produce false negatives where Orca reports "already ignored" for malformed
  // entries that git would treat as literal filenames. Exact-string matching
  // against the canonical patterns is safer and matches git's behavior. The
  // `\r?\n` split already strips Windows CRLF line endings, so individual
  // lines never carry `\r`.
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) {
      continue
    }
    // Why skip negations: a `!.worktrees/` line could un-ignore the directory.
    // Treating it as "ignored" would suppress the prompt and surprise the user.
    // Treating any negation as "not ignored" is the safer default — they get
    // the prompt and can opt out if their config is intentional.
    if (line.startsWith('!')) {
      continue
    }
    if (ROOT_WORKTREES_PATTERNS.has(line)) {
      return true
    }
  }
  return false
}

export function appendWorktreesEntry(content: string | null): string {
  const base = content ?? ''
  const needsLeadingNewline = base.length > 0 && !base.endsWith('\n')
  return `${base}${needsLeadingNewline ? '\n' : ''}.worktrees/\n`
}

export async function readGitignore(repoPath: string): Promise<string | null> {
  try {
    return await readFile(join(repoPath, GITIGNORE_NAME), 'utf-8')
  } catch (error) {
    // Why ENOENT = null (not throw): a missing .gitignore is a common state,
    // not an error. Callers use this to branch on "does the file exist at
    // all". Any other error (EACCES, EIO) still throws so we don't silently
    // hide real problems.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function isWorktreesDirIgnored(repoPath: string): Promise<boolean> {
  return isWorktreesDirIgnoredByGitignore(await readGitignore(repoPath))
}

export async function addWorktreesDirToGitignore(repoPath: string): Promise<void> {
  const content = await readGitignore(repoPath)
  // Why idempotent re-check: a racing second click or rapid second create
  // must not duplicate the entry. Trusting the renderer to only call this
  // when needed would be fragile — re-checking costs one file read and makes
  // the function safe to call repeatedly.
  if (isWorktreesDirIgnoredByGitignore(content)) {
    return
  }
  await writeFile(join(repoPath, GITIGNORE_NAME), appendWorktreesEntry(content), 'utf-8')
}
