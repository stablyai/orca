/**
 * Status and conflict-detection operations extracted from git-handler.ts.
 *
 * Why: oxlint max-lines (300) requires splitting large files.
 * These functions are pure data operations on git state — no class coupling.
 */
import * as path from 'path'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { parseUnmergedEntry } from './git-handler-utils'
import { parseStatusOutput } from './git-status-output-parser'
import type { GitExec } from './git-handler-ops'
import type { GitUpstreamStatus } from '../shared/types'
import {
  getEffectiveGitUpstreamStatus,
  splitRemoteBranchName
} from '../shared/git-effective-upstream'

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
  params: Record<string, unknown>
): Promise<{
  entries: Record<string, unknown>[]
  conflictOperation: string
  head?: string
  branch?: string
  upstreamStatus?: GitUpstreamStatus
  ignoredPaths?: string[]
}> {
  const worktreePath = params.worktreePath as string
  const includeIgnored = params.includeIgnored === true
  const conflictOperation = await detectConflictOperation(worktreePath)
  const entries: Record<string, unknown>[] = []
  let head: string | undefined
  let branch: string | undefined
  let upstreamStatus: GitUpstreamStatus | undefined
  let ignoredPaths: string[] = []

  try {
    // Why: -c core.quotePath=false keeps non-ASCII filenames as raw UTF-8 in
    // git's stdout instead of C-style octal escapes; without it the parsed
    // entry.path renders as gibberish in the source-control sidebar and
    // downstream blob lookups miss.
    const statusArgs = [
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all'
    ]
    if (includeIgnored) {
      statusArgs.push('--ignored=matching')
    }
    const { stdout } = await git(statusArgs, worktreePath, {
      // Why: status polling is read-like; avoid refreshing the index and racing
      // terminal Git commands on `.git/worktrees/*/index.lock`.
      disableOptionalLocks: true
    })
    const parsed = parseStatusOutput(stdout)
    entries.push(...parsed.entries)
    head = parsed.head
    branch = parsed.branch
    upstreamStatus = parsed.upstreamStatus
    ignoredPaths = parsed.ignoredPaths
    if (shouldProbeEffectiveUpstreamStatus(branch, upstreamStatus?.upstreamName)) {
      try {
        upstreamStatus = await getEffectiveGitUpstreamStatus((args) => git(args, worktreePath))
      } catch {
        // Why: status polling should keep returning working-tree entries even
        // if the richer upstream probe hits a transient SSH/git ref error.
      }
    }

    for (const uLine of parsed.unmergedLines) {
      const entry = parseUnmergedEntry(worktreePath, uLine)
      if (entry) {
        entries.push(entry)
      }
    }
  } catch {
    // not a git repo or git not available
  }

  return {
    entries,
    conflictOperation,
    head,
    branch,
    upstreamStatus,
    ...(includeIgnored ? { ignoredPaths } : {})
  }
}

function getShortBranchName(branch: string | undefined): string | null {
  const prefix = 'refs/heads/'
  return branch?.startsWith(prefix) ? branch.slice(prefix.length) : null
}

function shouldProbeEffectiveUpstreamStatus(
  branch: string | undefined,
  upstreamName: string | undefined
): boolean {
  const branchName = getShortBranchName(branch)
  if (!branchName) {
    return false
  }
  if (!upstreamName) {
    return true
  }
  const parsed = splitRemoteBranchName(upstreamName)
  return parsed?.remoteName === 'origin' && parsed.branchName !== branchName
}

function parseCheckIgnoreOutput(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter(Boolean)
}

export async function checkIgnoredPathsOp(
  git: GitExec,
  params: Record<string, unknown>
): Promise<string[]> {
  const worktreePath = params.worktreePath as string
  const paths = Array.isArray(params.paths)
    ? params.paths.filter((path): path is string => typeof path === 'string' && path.length > 0)
    : []
  if (paths.length === 0) {
    return []
  }

  try {
    const { stdout } = await git(
      ['-c', 'core.quotePath=false', 'check-ignore', '--', ...paths],
      worktreePath
    )
    return parseCheckIgnoreOutput(stdout)
  } catch (error) {
    const gitError = error as Error & { code?: number | string; stdout?: string }
    if (gitError.code === 1) {
      return parseCheckIgnoreOutput(gitError.stdout ?? '')
    }
    throw error
  }
}
