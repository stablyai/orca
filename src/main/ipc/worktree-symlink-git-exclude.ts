import { appendFile, lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Root-anchored pattern with no trailing slash.
 *
 * Why: directory-only rules (`node_modules/`) match real directories but not the
 * worktree shared-dir symlink Git treats as a file, so `git add -A` can stage a
 * mode-120000 blob whose content is the absolute primary path (issue #11077).
 */
export function sharedSymlinkExcludePattern(relativePath: string): string | null {
  const rel = relativePath.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (
    !rel ||
    isAbsolute(rel) ||
    rel.split('/').includes('..') ||
    rel.includes('\r') ||
    rel.includes('\n') ||
    rel.includes('\u0000')
  ) {
    return null
  }
  return `/${rel}`
}

function excludePatternAlreadyListed(content: string, pattern: string): boolean {
  const bare = pattern.startsWith('/') ? pattern.slice(1) : pattern
  const candidates = new Set([pattern, `${pattern}/`, bare, `${bare}/`])
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => candidates.has(line))
}

/** Resolve the shared git common dir (where `info/exclude` lives) for a worktree. */
export async function resolveWorktreeGitCommonDir(worktreePath: string): Promise<string | null> {
  const dotGitPath = join(worktreePath, '.git')
  try {
    const dotGitStat = await stat(dotGitPath)
    if (dotGitStat.isDirectory()) {
      return dotGitPath
    }
    if (!dotGitStat.isFile()) {
      return null
    }
    const content = await readFile(dotGitPath, 'utf8')
    const gitDirMatch = content.match(/^gitdir:\s*(.+)\s*$/m)
    if (!gitDirMatch) {
      return null
    }
    const gitDirRaw = gitDirMatch[1].trim()
    const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(worktreePath, gitDirRaw)
    try {
      const commonRaw = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
      if (commonRaw.length > 0) {
        return isAbsolute(commonRaw) ? commonRaw : resolve(gitDir, commonRaw)
      }
    } catch {
      // Why: older layouts may omit commondir; fall through to path heuristic.
    }
    // Why: linked worktree gitdirs live at <common>/worktrees/<name>.
    if (basename(dirname(gitDir)) === 'worktrees') {
      return dirname(dirname(gitDir))
    }
    return gitDir
  } catch {
    return null
  }
}

async function collectSymlinkExcludePatterns(
  worktreePath: string,
  relativePaths: readonly string[]
): Promise<string[]> {
  const patterns: string[] = []
  const seen = new Set<string>()
  for (const rawPath of relativePaths) {
    const pattern = sharedSymlinkExcludePattern(rawPath)
    if (!pattern || seen.has(pattern)) {
      continue
    }
    const target = resolve(worktreePath, pattern.slice(1))
    try {
      // Why: only positively identified shared symlinks need exclude widening;
      // APFS clones / real dirs already match directory-only ignore rules.
      if (!(await lstat(target)).isSymbolicLink()) {
        continue
      }
    } catch {
      continue
    }
    seen.add(pattern)
    patterns.push(pattern)
  }
  return patterns
}

/**
 * Idempotently append root-anchored ignore rules for shared-directory symlinks
 * to the repo's `info/exclude` so agents' `git add -A` cannot stage them.
 *
 * Failures are swallowed by the caller — exclude maintenance must never block
 * worktree creation. Scope is repo-wide (common dir), matching Git's exclude
 * resolution from linked worktrees.
 */
export async function ensureWorktreeSharedSymlinkExclude(
  worktreePath: string,
  relativePaths: readonly string[]
): Promise<void> {
  if (relativePaths.length === 0) {
    return
  }
  const patterns = await collectSymlinkExcludePatterns(worktreePath, relativePaths)
  if (patterns.length === 0) {
    return
  }
  const commonDir = await resolveWorktreeGitCommonDir(worktreePath)
  if (!commonDir) {
    return
  }
  const excludePath = join(commonDir, 'info', 'exclude')
  let existingContent = ''
  try {
    existingContent = await readFile(excludePath, 'utf8')
  } catch {
    // info/exclude may be absent until we create it.
  }
  const missing = patterns.filter(
    (pattern) => !excludePatternAlreadyListed(existingContent, pattern)
  )
  if (missing.length === 0) {
    return
  }
  await mkdir(dirname(excludePath), { recursive: true })
  const needsLeadingNewline = existingContent.length > 0 && !existingContent.endsWith('\n')
  const body = `${missing.join('\n')}\n`
  await appendFile(excludePath, `${needsLeadingNewline ? '\n' : ''}${body}`, 'utf8')
}
