/**
 * Higher-level git operations extracted from git-handler.ts.
 *
 * Why: oxlint max-lines requires files to stay under 300 lines.
 * These async operations accept a git executor callback so they
 * remain decoupled from the GitHandler class.
 */
import * as path from 'path'
import { readFile } from 'fs/promises'
import { bufferToBlob, buildDiffResult, parseBranchDiff } from './git-handler-utils'

// ─── Executor types ──────────────────────────────────────────────────

export type GitExec = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>

export type GitBufferExec = (args: string[], cwd: string) => Promise<Buffer>

// ─── Blob reading ────────────────────────────────────────────────────

export async function readBlobAtOid(
  gitBuffer: GitBufferExec,
  cwd: string,
  oid: string,
  filePath: string
): Promise<{ content: string; isBinary: boolean }> {
  try {
    const buf = await gitBuffer(['show', `${oid}:${filePath}`], cwd)
    return bufferToBlob(buf, filePath)
  } catch {
    return { content: '', isBinary: false }
  }
}

export async function readBlobAtIndex(
  gitBuffer: GitBufferExec,
  cwd: string,
  filePath: string
): Promise<{ content: string; isBinary: boolean }> {
  try {
    const buf = await gitBuffer(['show', `:${filePath}`], cwd)
    return bufferToBlob(buf, filePath)
  } catch {
    return { content: '', isBinary: false }
  }
}

export async function readUnstagedLeft(
  gitBuffer: GitBufferExec,
  cwd: string,
  filePath: string
): Promise<{ content: string; isBinary: boolean }> {
  const index = await readBlobAtIndex(gitBuffer, cwd, filePath)
  if (index.content || index.isBinary) {
    return index
  }
  return readBlobAtOid(gitBuffer, cwd, 'HEAD', filePath)
}

export async function readWorkingFile(
  absPath: string
): Promise<{ content: string; isBinary: boolean }> {
  try {
    const buffer = await readFile(absPath)
    return bufferToBlob(buffer)
  } catch {
    return { content: '', isBinary: false }
  }
}

// ─── Diff ────────────────────────────────────────────────────────────

export async function computeDiff(
  git: GitBufferExec,
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead = false
) {
  let originalContent = ''
  let modifiedContent = ''
  let originalIsBinary = false
  let modifiedIsBinary = false

  try {
    if (staged) {
      const left = await readBlobAtOid(git, worktreePath, 'HEAD', filePath)
      originalContent = left.content
      originalIsBinary = left.isBinary

      const right = await readBlobAtIndex(git, worktreePath, filePath)
      modifiedContent = right.content
      modifiedIsBinary = right.isBinary
    } else {
      const left = compareAgainstHead
        ? await readBlobAtOid(git, worktreePath, 'HEAD', filePath)
        : await readUnstagedLeft(git, worktreePath, filePath)
      originalContent = left.content
      originalIsBinary = left.isBinary

      const right = await readWorkingFile(path.join(worktreePath, filePath))
      modifiedContent = right.content
      modifiedIsBinary = right.isBinary
    }
  } catch {
    // Fallback to empty
  }

  return buildDiffResult(
    originalContent,
    modifiedContent,
    originalIsBinary,
    modifiedIsBinary,
    filePath
  )
}

// ─── Branch compare ──────────────────────────────────────────────────

export async function branchCompare(
  git: GitExec,
  worktreePath: string,
  baseRef: string,
  loadBranchChanges: (mergeBase: string, headOid: string) => Promise<Record<string, unknown>[]>
) {
  const summary: Record<string, unknown> = {
    baseRef,
    baseOid: null,
    compareRef: 'HEAD',
    headOid: null,
    mergeBase: null,
    changedFiles: 0,
    status: 'loading'
  }

  try {
    const { stdout: branchOut } = await git(['branch', '--show-current'], worktreePath)
    const branch = branchOut.trim()
    if (branch) {
      summary.compareRef = branch
    }
  } catch {
    /* keep HEAD */
  }

  let headOid: string
  try {
    const { stdout } = await git(['rev-parse', '--verify', 'HEAD'], worktreePath)
    headOid = stdout.trim()
    summary.headOid = headOid
  } catch {
    summary.status = 'unborn-head'
    summary.errorMessage =
      'This branch does not have a committed HEAD yet, so compare-to-base is unavailable.'
    return { summary, entries: [] }
  }

  let baseOid: string
  try {
    const { stdout } = await git(['rev-parse', '--verify', baseRef], worktreePath)
    baseOid = stdout.trim()
    summary.baseOid = baseOid
  } catch {
    summary.status = 'invalid-base'
    summary.errorMessage = `Base ref ${baseRef} could not be resolved in this repository.`
    return { summary, entries: [] }
  }

  let mergeBase: string
  try {
    const { stdout } = await git(['merge-base', baseOid, headOid], worktreePath)
    mergeBase = stdout.trim()
    summary.mergeBase = mergeBase
  } catch {
    summary.status = 'no-merge-base'
    summary.errorMessage = `This branch and ${baseRef} do not share a merge base, so compare-to-base is unavailable.`
    return { summary, entries: [] }
  }

  try {
    const entries = await loadBranchChanges(mergeBase, headOid)
    const { stdout: countOut } = await git(
      ['rev-list', '--count', `${baseOid}..${headOid}`],
      worktreePath
    )
    summary.changedFiles = entries.length
    summary.commitsAhead = parseInt(countOut.trim(), 10) || 0
    summary.status = 'ready'
    return { summary, entries }
  } catch (error) {
    summary.status = 'error'
    summary.errorMessage = error instanceof Error ? error.message : 'Failed to load branch compare'
    return { summary, entries: [] }
  }
}

// ─── Branch diff ─────────────────────────────────────────────────────

export async function branchDiffEntries(
  git: GitExec,
  gitBuffer: GitBufferExec,
  worktreePath: string,
  baseRef: string,
  opts: { includePatch?: boolean; filePath?: string; oldPath?: string }
) {
  let headOid: string
  let mergeBase: string
  try {
    const { stdout: headOut } = await git(['rev-parse', '--verify', 'HEAD'], worktreePath)
    headOid = headOut.trim()

    const { stdout: baseOut } = await git(['rev-parse', '--verify', baseRef], worktreePath)
    const baseOid = baseOut.trim()

    const { stdout: mbOut } = await git(['merge-base', baseOid, headOid], worktreePath)
    mergeBase = mbOut.trim()
  } catch {
    return []
  }

  // Why: see core.quotePath rationale in getStatusOp — keep UTF-8 paths intact.
  const { stdout } = await git(
    ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-C', mergeBase, headOid],
    worktreePath
  )
  const allChanges = parseBranchDiff(stdout)

  // Why: the IPC handler for single-file branch diff sends filePath/oldPath
  // to avoid reading blobs for every changed file — only the matched file.
  let changes = allChanges
  if (opts.filePath) {
    changes = allChanges.filter(
      (c) =>
        c.path === opts.filePath ||
        c.oldPath === opts.filePath ||
        (opts.oldPath && (c.path === opts.oldPath || c.oldPath === opts.oldPath))
    )
  }

  if (!opts.includePatch) {
    return changes.map(() => ({
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    }))
  }

  const results: Record<string, unknown>[] = []
  for (const change of changes) {
    const fp = change.path as string
    const oldP = (change.oldPath as string) ?? fp
    try {
      const left = await readBlobAtOid(gitBuffer, worktreePath, mergeBase, oldP)
      const right = await readBlobAtOid(gitBuffer, worktreePath, headOid, fp)
      results.push(buildDiffResult(left.content, right.content, left.isBinary, right.isBinary, fp))
    } catch {
      results.push({
        kind: 'text',
        originalContent: '',
        modifiedContent: '',
        originalIsBinary: false,
        modifiedIsBinary: false
      })
    }
  }
  return results
}

export { validateGitExecArgs } from './git-exec-validator'
