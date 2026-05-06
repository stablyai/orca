/**
 * Status and conflict-detection operations extracted from git-handler.ts.
 *
 * Why: oxlint max-lines (300) requires splitting large files.
 * These functions are pure data operations on git state — no class coupling.
 */
import * as path from 'path'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { parseStatusOutput, parseUnmergedEntry } from './git-handler-utils'
import type { GitExec } from './git-handler-ops'

export async function resolveGitDir(worktreePath: string): Promise<string> {
  const dotGitPath = path.join(worktreePath, '.git')
  try {
    const contents = await readFile(dotGitPath, 'utf-8')
    const match = contents.match(/^gitdir:\s*(.+)\s*$/m)
    if (match) {
      return path.resolve(worktreePath, match[1])
    }
  } catch {
    // .git is a directory, not a file
  }
  return dotGitPath
}

export async function detectConflictOperation(worktreePath: string): Promise<string> {
  const gitDir = await resolveGitDir(worktreePath)
  try {
    if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
      return 'merge'
    }
    if (
      existsSync(path.join(gitDir, 'rebase-merge')) ||
      existsSync(path.join(gitDir, 'rebase-apply'))
    ) {
      return 'rebase'
    }
    if (existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
      return 'cherry-pick'
    }
  } catch {
    // fs error — treat as no conflict operation
  }
  return 'unknown'
}

export async function getStatusOp(
  git: GitExec,
  validatePath: (p: string) => void,
  params: Record<string, unknown>
): Promise<{ entries: Record<string, unknown>[]; conflictOperation: string }> {
  const worktreePath = params.worktreePath as string
  validatePath(worktreePath)
  const conflictOperation = await detectConflictOperation(worktreePath)
  const entries: Record<string, unknown>[] = []

  try {
    // Why: -c core.quotePath=false keeps non-ASCII filenames as raw UTF-8 in
    // git's stdout instead of C-style octal escapes; without it the parsed
    // entry.path renders as gibberish in the source-control sidebar and
    // downstream blob lookups miss.
    const { stdout } = await git(
      ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--untracked-files=all'],
      worktreePath
    )
    const parsed = parseStatusOutput(stdout)
    entries.push(...parsed.entries)

    for (const uLine of parsed.unmergedLines) {
      const entry = parseUnmergedEntry(worktreePath, uLine)
      if (entry) {
        entries.push(entry)
      }
    }
  } catch {
    // not a git repo or git not available
  }

  return { entries, conflictOperation }
}
