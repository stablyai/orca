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
