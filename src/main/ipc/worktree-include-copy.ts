import type { WorktreeIncludeCopyResult, WorktreeIncludeCopySkipReason } from '../../shared/types'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import type { IFilesystemProvider } from '../providers/types'
import {
  WORKTREE_INCLUDE_FILENAME,
  createLocalWorktreeIncludeOps,
  createRemoteWorktreeIncludeOps,
  type RemoteWorktreeIncludeGitOps,
  type WorktreeIncludeHostOps
} from './worktree-include-host-ops'

export { WORKTREE_INCLUDE_FILENAME }

export type ParsedWorktreeInclude = {
  entries: string[]
  malformed: string[]
}

export function parseWorktreeInclude(content: string): ParsedWorktreeInclude {
  const entries: string[] = []
  const malformed: string[] = []
  const seen = new Set<string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    // Why: entries are exact repo-relative file paths. Absolute paths and
    // `..` traversal could escape the repo root, glob characters signal an
    // unsupported pattern, and a leading `:` is git pathspec magic (e.g.
    // `:(icase)`) that would make `git ls-files`/`check-ignore` exit fatally
    // and downgrade every entry to check-failed — all are rejected here
    // (warned, never fatal) instead of guessed at.
    const normalized = line
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.')
      .join('/')
    if (
      !normalized ||
      line.startsWith('/') ||
      line.startsWith('\\') ||
      normalized.startsWith(':') ||
      /^[a-zA-Z]:/.test(normalized) ||
      normalized.split('/').includes('..') ||
      /[*?[\]]/.test(normalized)
    ) {
      malformed.push(line)
      continue
    }
    if (!seen.has(normalized)) {
      seen.add(normalized)
      entries.push(normalized)
    }
  }
  return { entries, malformed }
}

async function runWorktreeIncludeCopy(
  ops: WorktreeIncludeHostOps
): Promise<WorktreeIncludeCopyResult | undefined> {
  const content = await ops.readIncludeFile()
  if (content === null) {
    return undefined
  }
  const { entries, malformed } = parseWorktreeInclude(content)
  const skipped: WorktreeIncludeCopyResult['skipped'] = []
  for (const line of malformed) {
    console.warn(
      `[worktree-include] Skipping malformed ${WORKTREE_INCLUDE_FILENAME} entry "${line}" ` +
        '(exact repo-relative file paths only — no globs, "..", or absolute paths)'
    )
    skipped.push({ path: line, reason: 'malformed' })
  }
  if (entries.length === 0) {
    return { copied: [], skipped }
  }

  let tracked: Set<string>
  let ignored: Set<string>
  try {
    tracked = new Set(await ops.listTrackedPaths(entries))
    const candidates = entries.filter((entry) => !tracked.has(entry))
    ignored = new Set(candidates.length > 0 ? await ops.listIgnoredPaths(candidates) : [])
  } catch (error) {
    // Why: without a trustworthy tracked/ignored answer we cannot tell setup
    // secrets apart from repo content, so copy nothing rather than guess.
    console.warn(
      `[worktree-include] git tracked/ignored check failed; skipping all entries:`,
      error
    )
    return {
      copied: [],
      skipped: [
        ...skipped,
        ...entries.map((path) => ({
          path,
          reason: 'check-failed' as WorktreeIncludeCopySkipReason
        }))
      ]
    }
  }

  // Why: entries are independent once tracked/ignored status is known, so
  // copy concurrently — on remote hosts each file costs several relay round
  // trips. Outcomes are folded back in manifest order to keep results (and
  // the tests that assert on them) deterministic.
  const outcomes = await Promise.all(
    entries.map((entry) => copyEntryToWorktree(entry, ops, tracked, ignored))
  )
  const copied: string[] = []
  entries.forEach((entry, index) => {
    const outcome = outcomes[index]
    if (outcome === 'copied') {
      copied.push(entry)
    } else if (outcome) {
      skipped.push({ path: entry, reason: outcome })
    }
  })
  return { copied, skipped }
}

async function copyEntryToWorktree(
  entry: string,
  ops: WorktreeIncludeHostOps,
  tracked: Set<string>,
  ignored: Set<string>
): Promise<'copied' | WorktreeIncludeCopySkipReason> {
  if (tracked.has(entry)) {
    console.log(
      `[worktree-include] Skipping tracked entry "${entry}" (only gitignored files are copied)`
    )
    return 'tracked'
  }
  if (!ignored.has(entry)) {
    console.log(`[worktree-include] Skipping "${entry}": not gitignored in the primary checkout`)
    return 'not-ignored'
  }
  try {
    const outcome = await ops.copyFileNoClobber(entry)
    if (outcome === 'not-a-file') {
      console.warn(
        `[worktree-include] Skipping "${entry}": not a regular file (directories are not supported)`
      )
    }
    return outcome
  } catch (error) {
    console.warn(`[worktree-include] Failed to copy "${entry}":`, error)
    return 'copy-failed'
  }
}

function logIncludeCopySummary(
  worktreePath: string,
  result: WorktreeIncludeCopyResult | undefined
): void {
  if (!result || (result.copied.length === 0 && result.skipped.length === 0)) {
    return
  }
  const copiedSummary = result.copied.length > 0 ? result.copied.join(', ') : 'none'
  const skippedSummary = result.skipped.map((skip) => `${skip.path} (${skip.reason})`).join(', ')
  const skippedSuffix = skippedSummary ? `; skipped ${skippedSummary}` : ''
  console.log(
    `[worktree-include] ${worktreePath}: copied ${result.copied.length} — ${copiedSummary}${skippedSuffix}`
  )
}

// Why: any failure must degrade to a log line — the git worktree already
// exists at this point and a copy problem must not abort creation.
async function copyWorktreeIncludeFilesSafely(
  worktreePath: string,
  ops: WorktreeIncludeHostOps
): Promise<WorktreeIncludeCopyResult | undefined> {
  try {
    const result = await runWorktreeIncludeCopy(ops)
    logIncludeCopySummary(worktreePath, result)
    return result
  } catch (error) {
    console.warn(`[worktree-include] include copy failed for ${worktreePath}:`, error)
    return undefined
  }
}

/** Copy `.worktreeinclude`-listed gitignored files from the primary checkout
 *  into a freshly created local worktree. Never throws; returns undefined
 *  when no `.worktreeinclude` exists. */
export async function copyLocalWorktreeIncludeFiles(
  repoPath: string,
  worktreePath: string,
  gitOptions: GitRuntimeOptions = {}
): Promise<WorktreeIncludeCopyResult | undefined> {
  return copyWorktreeIncludeFilesSafely(
    worktreePath,
    createLocalWorktreeIncludeOps(repoPath, worktreePath, gitOptions)
  )
}

/** Remote-host variant of {@link copyLocalWorktreeIncludeFiles}. The copy runs
 *  entirely on the remote host via the relay's no-clobber fs.copy, so listed
 *  files never leave the machine they already live on. */
export async function copyRemoteWorktreeIncludeFiles(
  repoPath: string,
  worktreePath: string,
  gitProvider: RemoteWorktreeIncludeGitOps,
  fsProvider: IFilesystemProvider
): Promise<WorktreeIncludeCopyResult | undefined> {
  return copyWorktreeIncludeFilesSafely(
    worktreePath,
    createRemoteWorktreeIncludeOps(repoPath, worktreePath, gitProvider, fsProvider)
  )
}
