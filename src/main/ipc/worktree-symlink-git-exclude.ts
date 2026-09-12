import { appendFile, lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Normalize a worktree-relative shared path for filesystem lookup. */
function normalizeSharedRelativePath(relativePath: string): string | null {
  // Why: do not trim trailing spaces — they can be part of a real basename.
  const rel = relativePath.replace(/\\/g, '/').replace(/^[\s/]+/, '').replace(/\/+$/, '')
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
  return rel
}

/** Escape one path segment so Git treats it as a literal exclude entry. */
function escapeGitignoreLiteralSegment(segment: string): string {
  // Why: gitignore strips unescaped trailing spaces and treats *,?,[] as globs.
  // Shared symlink basenames can contain those characters; exclude must match
  // the literal filesystem name only.
  return segment
    .replace(/\\/g, '\\\\')
    .replace(/([*?[\]])/g, '\\$1')
    .replace(/ /g, '\\ ')
}

/**
 * Root-anchored pattern with no trailing slash.
 *
 * Why: directory-only rules (`node_modules/`) match real directories but not the
 * worktree shared-dir symlink Git treats as a file, so `git add -A` can stage a
 * mode-120000 blob whose content is the absolute primary path (issue #11077).
 */
export function sharedSymlinkExcludePattern(relativePath: string): string | null {
  const rel = normalizeSharedRelativePath(relativePath)
  if (!rel) {
    return null
  }
  return `/${rel.split('/').map(escapeGitignoreLiteralSegment).join('/')}`
}

function excludePatternAlreadyListed(content: string, pattern: string): boolean {
  // Why: only exact bare/`/`-anchored forms cover symlinks. Directory-only
  // `name/` must NOT count as already listed — that is the bug this PR fixes.
  const bare = pattern.startsWith('/') ? pattern.slice(1) : pattern
  const candidates = new Set([pattern, bare])
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
    const rel = normalizeSharedRelativePath(rawPath)
    const pattern = sharedSymlinkExcludePattern(rawPath)
    if (!rel || !pattern || seen.has(pattern)) {
      continue
    }
    // Why: exclude patterns escape git metacharacters; filesystem resolve must
    // use the unescaped relative path or `cache*` becomes `cache\*`.
    const target = resolve(worktreePath, rel)
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
