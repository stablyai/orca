/* eslint-disable max-lines */
import { existsSync } from 'fs'
import { readFile, rm } from 'fs/promises'
import * as path from 'path'
import type {
  GitBranchChangeEntry,
  GitBranchChangeStatus,
  GitBranchCompareResult,
  GitBranchCompareSummary,
  GitConflictKind,
  GitConflictOperation,
  GitDiffResult,
  GitFileStatus,
  GitStatusEntry,
  GitStatusResult
} from '../../shared/types'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from './runner'

const MAX_GIT_SHOW_BYTES = 10 * 1024 * 1024

/**
 * Parse `git status --porcelain=v2` output into structured entries.
 */
export async function getStatus(worktreePath: string): Promise<GitStatusResult> {
  const entries: GitStatusEntry[] = []

  // Why: detectConflictOperation (4 existsSync + readFile) and git status are
  // independent. Running them concurrently saves one round-trip of I/O latency.
  const conflictPromise = detectConflictOperation(worktreePath)
  // Why: -c core.quotePath=false keeps non-ASCII filenames (Japanese, emoji,
  // etc.) as raw UTF-8 instead of git's default C-style octal escapes wrapped
  // in double quotes. Without it, the parsed entry.path is unreadable in the
  // sidebar and downstream `git show :"docs/\346..."` lookups silently miss.
  const statusPromise = gitExecFileAsync(
    ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--untracked-files=all'],
    { cwd: worktreePath }
  )
  const conflictOperation = await conflictPromise

  try {
    const { stdout } = await statusPromise

    // [Fix]: Split by /\r?\n/ instead of '\n' to correctly parse git output on Windows,
    // avoiding trailing \r characters in parsed paths.
    for (const line of stdout.split(/\r?\n/)) {
      if (!line) {
        continue
      }

      if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // Changed entries: "1 XY sub mH mI mW hH path" or "2 XY sub mH mI mW hH X\tscore\tpath\torigPath"
        const parts = line.split(' ')
        const xy = parts[1]
        const indexStatus = xy[0]
        const worktreeStatus = xy[1]

        if (line.startsWith('2 ')) {
          // Rename entry - tab separated at the end
          const tabParts = line.split('\t')
          const path = tabParts[1]
          const oldPath = tabParts[2]
          if (indexStatus !== '.') {
            entries.push({ path, status: parseStatusChar(indexStatus), area: 'staged', oldPath })
          }
          if (worktreeStatus !== '.') {
            entries.push({
              path,
              status: parseStatusChar(worktreeStatus),
              area: 'unstaged',
              oldPath
            })
          }
        } else {
          // Regular change entry
          const path = parts.slice(8).join(' ')
          if (indexStatus !== '.') {
            entries.push({ path, status: parseStatusChar(indexStatus), area: 'staged' })
          }
          if (worktreeStatus !== '.') {
            entries.push({ path, status: parseStatusChar(worktreeStatus), area: 'unstaged' })
          }
        }
      } else if (line.startsWith('? ')) {
        // Untracked file
        const path = line.slice(2)
        entries.push({ path, status: 'untracked', area: 'untracked' })
      } else if (line.startsWith('u ')) {
        const unmergedEntry = await parseUnmergedEntry(worktreePath, line)
        if (unmergedEntry) {
          entries.push(unmergedEntry)
        }
      }
    }
  } catch {
    // Not a git repo or git not available
  }

  return { entries, conflictOperation }
}

function parseStatusChar(char: string): GitFileStatus {
  switch (char) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

function parseBranchStatusChar(char: string): GitBranchChangeStatus {
  switch (char) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

async function parseUnmergedEntry(
  worktreePath: string,
  line: string
): Promise<GitStatusEntry | null> {
  // Why: porcelain v2 unmerged entries are fully space-separated (like type-1
  // ordinary entries), NOT tab-separated. The format is:
  //   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
  // The path starts at field index 10 and may contain spaces, so we join the
  // remaining fields. The earlier tab-based parsing silently dropped all
  // unmerged entries because the tab was never present.
  const parts = line.split(' ')
  const xy = parts[1]
  const modeStage1 = parts[3]
  const modeStage2 = parts[4]
  const modeStage3 = parts[5]
  const filePath = parts.slice(10).join(' ')
  if (!filePath) {
    return null
  }

  // Why: submodule conflicts (mode 160000) are out of scope for v1.
  // Presenting them with normal file-conflict UX would be misleading because
  // submodule resolution requires different Git commands and user mental model.
  if ([modeStage1, modeStage2, modeStage3].some((mode) => mode === '160000')) {
    return null
  }

  const conflictKind = parseConflictKind(xy)
  if (!conflictKind) {
    return null
  }

  // Why: porcelain v2 `u` records do not provide rename-origin metadata (unlike
  // `2` records), so oldPath is intentionally omitted. v1 should not promise
  // rename ancestry in conflict rows without a separate Git query.
  return {
    path: filePath,
    area: 'unstaged',
    status: await getConflictCompatibilityStatus(worktreePath, filePath, conflictKind),
    conflictKind,
    conflictStatus: 'unresolved'
  }
}

function parseConflictKind(xy: string): GitConflictKind | null {
  switch (xy) {
    case 'UU':
      return 'both_modified'
    case 'AA':
      return 'both_added'
    case 'DD':
      return 'both_deleted'
    case 'AU':
      return 'added_by_us'
    case 'UA':
      return 'added_by_them'
    case 'DU':
      return 'deleted_by_us'
    case 'UD':
      return 'deleted_by_them'
    default:
      return null
  }
}

// Why: the `status` field on conflict entries is a *rendering compatibility*
// choice for existing icon/color plumbing, not a semantic claim about the file.
// The conflict badge and subtype carry the real meaning. We use 'modified' when
// a working-tree file exists and 'deleted' when it does not, so that downstream
// consumers (file explorer decorations, tab badges) get a reasonable fallback
// without needing conflict-aware upgrades in v1.
//
// For `deleted_by_us` / `deleted_by_them` and the `added_by_*` variants, Git's
// behavior depends on the merge strategy, so we check the filesystem rather
// than hardcoding an assumption.
async function getConflictCompatibilityStatus(
  worktreePath: string,
  filePath: string,
  conflictKind: GitConflictKind
): Promise<GitFileStatus> {
  if (conflictKind === 'both_modified' || conflictKind === 'both_added') {
    return 'modified'
  }

  if (conflictKind === 'both_deleted') {
    return 'deleted'
  }

  try {
    return existsSync(path.join(worktreePath, filePath)) ? 'modified' : 'deleted'
  } catch {
    // Why: if the filesystem check throws (permissions error, unmounted path,
    // etc.), 'modified' is the safer fallback. It avoids suppressing the row
    // from the sidebar and avoids a misleading 'deleted' when we simply could
    // not check. The conflict badge still carries the real semantics.
    return 'modified'
  }
}

// Why: there is an inherent race between the `git status` call and these
// fs.existsSync checks — the HEAD file may not yet exist or may already be
// cleaned up by the time we check. In that case we fall back to 'unknown' for
// one poll cycle, which is acceptable. The renderer uses this to label the
// merge summary ("Merge conflicts" vs "Rebase conflicts" vs generic "Conflicts").
//
// Why rebase detection relies on rebase-merge/ or rebase-apply/ directories
// instead of REBASE_HEAD: those directories persist for the entire rebase, so
// they cover both conflicting and non-conflicting steps. REBASE_HEAD, by
// contrast, only exists on some steps and can also be left behind after a
// completed rebase, which would make the UI show a stale "Rebasing" badge.
export async function detectConflictOperation(worktreePath: string): Promise<GitConflictOperation> {
  const gitDir = await resolveGitDir(worktreePath)
  const mergeHead = path.join(gitDir, 'MERGE_HEAD')
  const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD')
  const rebaseMergeDir = path.join(gitDir, 'rebase-merge')
  const rebaseApplyDir = path.join(gitDir, 'rebase-apply')

  let hasMergeHead = false
  let hasCherryPickHead = false
  let hasRebaseDir = false

  try {
    hasMergeHead = existsSync(mergeHead)
    hasCherryPickHead = existsSync(cherryPickHead)
    hasRebaseDir = existsSync(rebaseMergeDir) || existsSync(rebaseApplyDir)
  } catch {
    return 'unknown'
  }

  if (hasMergeHead) {
    return 'merge'
  }
  if (hasRebaseDir) {
    return 'rebase'
  }
  if (hasCherryPickHead) {
    return 'cherry-pick'
  }
  return 'unknown'
}

export async function resolveGitDir(worktreePath: string): Promise<string> {
  const dotGitPath = path.join(worktreePath, '.git')

  try {
    const dotGitContents = await readFile(dotGitPath, 'utf-8')
    const match = dotGitContents.match(/^gitdir:\s*(.+)\s*$/m)
    if (match) {
      return path.resolve(worktreePath, match[1])
    }
  } catch {
    // `.git` is likely a directory in a non-worktree checkout.
  }

  return dotGitPath
}

/**
 * Get original and modified content for diffing a file.
 */
export async function getDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead = false
): Promise<GitDiffResult> {
  let originalContent = ''
  let modifiedContent = ''
  let originalIsBinary = false
  let modifiedIsBinary = false

  try {
    const leftBlob = staged
      ? await readGitBlobAtOidPath(worktreePath, 'HEAD', filePath)
      : compareAgainstHead
        ? await readGitBlobAtOidPath(worktreePath, 'HEAD', filePath)
        : await readUnstagedLeftBlob(worktreePath, filePath)
    originalContent = leftBlob.content
    originalIsBinary = leftBlob.isBinary

    if (staged) {
      const rightBlob = await readGitBlobAtIndexPath(worktreePath, filePath)
      modifiedContent = rightBlob.content
      modifiedIsBinary = rightBlob.isBinary
    } else {
      const workingTreeBlob = await readWorkingTreeFile(path.join(worktreePath, filePath))
      modifiedContent = workingTreeBlob.content
      modifiedIsBinary = workingTreeBlob.isBinary
    }
  } catch {
    // Fallback
  }

  return buildDiffResult(
    originalContent,
    modifiedContent,
    originalIsBinary,
    modifiedIsBinary,
    filePath
  )
}

export async function getBranchCompare(
  worktreePath: string,
  baseRef: string
): Promise<GitBranchCompareResult> {
  const summary: GitBranchCompareSummary = {
    baseRef,
    baseOid: null,
    compareRef: 'HEAD',
    headOid: null,
    mergeBase: null,
    changedFiles: 0,
    status: 'loading'
  }

  const compareRef = await resolveCompareRef(worktreePath)
  summary.compareRef = compareRef

  let headOid = ''
  try {
    headOid = await resolveRefOid(worktreePath, 'HEAD')
    summary.headOid = headOid
  } catch {
    summary.status = 'unborn-head'
    summary.errorMessage =
      'This branch does not have a committed HEAD yet, so compare-to-base is unavailable.'
    return { summary, entries: [] }
  }

  let baseOid = ''
  try {
    baseOid = await resolveRefOid(worktreePath, baseRef)
    summary.baseOid = baseOid
  } catch {
    summary.status = 'invalid-base'
    summary.errorMessage = `Base ref ${baseRef} could not be resolved in this repository.`
    return { summary, entries: [] }
  }

  let mergeBase = ''
  try {
    mergeBase = await resolveMergeBase(worktreePath, baseOid, headOid)
    summary.mergeBase = mergeBase
  } catch {
    summary.status = 'no-merge-base'
    summary.errorMessage = `This branch and ${baseRef} do not share a merge base, so compare-to-base is unavailable.`
    return { summary, entries: [] }
  }

  try {
    const [entries, commitsAhead] = await Promise.all([
      loadBranchChanges(worktreePath, mergeBase, headOid),
      countAheadCommits(worktreePath, baseOid, headOid)
    ])
    summary.changedFiles = entries.length
    summary.commitsAhead = commitsAhead
    summary.status = 'ready'
    return { summary, entries }
  } catch (error) {
    summary.status = 'error'
    summary.errorMessage = error instanceof Error ? error.message : 'Failed to load branch compare'
    return { summary, entries: [] }
  }
}

export async function getBranchDiff(
  worktreePath: string,
  args: {
    headOid: string
    mergeBase: string
    filePath: string
    oldPath?: string
  }
): Promise<GitDiffResult> {
  try {
    const leftPath = args.oldPath ?? args.filePath
    const leftBlob = await readGitBlobAtOidPath(worktreePath, args.mergeBase, leftPath)
    const rightBlob = await readGitBlobAtOidPath(worktreePath, args.headOid, args.filePath)

    return buildDiffResult(
      leftBlob.content,
      rightBlob.content,
      leftBlob.isBinary,
      rightBlob.isBinary,
      args.filePath
    )
  } catch {
    return {
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }
}

async function loadBranchChanges(
  worktreePath: string,
  mergeBase: string,
  headOid: string
): Promise<GitBranchChangeEntry[]> {
  // Why: see core.quotePath=false rationale in getStatus — same reason here so
  // branch-diff entries render with their real UTF-8 paths.
  const { stdout } = await gitExecFileAsync(
    ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-C', mergeBase, headOid],
    { cwd: worktreePath, maxBuffer: MAX_GIT_SHOW_BYTES }
  )

  const entries: GitBranchChangeEntry[] = []
  // [Fix]: Split by /\r?\n/ instead of '\n' to handle Git CRLF output on Windows,
  // preventing trailing \r characters in extracted file paths.
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const entry = parseBranchChangeLine(line)
    if (entry) {
      entries.push(entry)
    }
  }
  return entries
}

function parseBranchChangeLine(line: string): GitBranchChangeEntry | null {
  const parts = line.split('\t')
  const rawStatus = parts[0] ?? ''
  const status = parseBranchStatusChar(rawStatus[0] ?? 'M')

  if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
    const oldPath = parts[1]
    const path = parts[2]
    if (!path) {
      return null
    }
    return { path, oldPath, status }
  }

  const path = parts[1]
  if (!path) {
    return null
  }

  return { path, status }
}

async function resolveCompareRef(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(['branch', '--show-current'], {
      cwd: worktreePath
    })
    const branch = stdout.trim()
    return branch || 'HEAD'
  } catch {
    return 'HEAD'
  }
}

async function resolveRefOid(worktreePath: string, ref: string): Promise<string> {
  const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', ref], {
    cwd: worktreePath
  })
  return stdout.trim()
}

async function resolveMergeBase(
  worktreePath: string,
  baseOid: string,
  headOid: string
): Promise<string> {
  const { stdout } = await gitExecFileAsync(['merge-base', baseOid, headOid], {
    cwd: worktreePath
  })
  return stdout.trim()
}

async function countAheadCommits(
  worktreePath: string,
  baseOid: string,
  headOid: string
): Promise<number> {
  const { stdout } = await gitExecFileAsync(['rev-list', '--count', `${baseOid}..${headOid}`], {
    cwd: worktreePath
  })
  return Number.parseInt(stdout.trim(), 10) || 0
}

async function readUnstagedLeftBlob(
  worktreePath: string,
  filePath: string
): Promise<GitBlobReadResult> {
  const indexBlob = await readGitBlobAtIndexPath(worktreePath, filePath)
  if (indexBlob.exists) {
    return indexBlob
  }

  return readGitBlobAtOidPath(worktreePath, 'HEAD', filePath)
}

async function readGitBlobAtIndexPath(
  worktreePath: string,
  filePath: string
): Promise<GitBlobReadResult> {
  try {
    const { stdout } = await gitExecFileAsyncBuffer(['show', `:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_GIT_SHOW_BYTES
    })

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch {
    return { content: '', isBinary: false, exists: false }
  }
}

async function readGitBlobAtOidPath(
  worktreePath: string,
  oid: string,
  filePath: string
): Promise<GitBlobReadResult> {
  try {
    const { stdout } = await gitExecFileAsyncBuffer(['show', `${oid}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_GIT_SHOW_BYTES
    })

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch {
    return { content: '', isBinary: false, exists: false }
  }
}

async function readWorkingTreeFile(filePath: string): Promise<GitBlobReadResult> {
  try {
    const buffer = await readFile(filePath)
    return bufferToBlob(buffer, filePath)
  } catch {
    return { content: '', isBinary: false, exists: false }
  }
}

function bufferToBlob(buffer: Buffer, filePath?: string): GitBlobReadResult {
  const isBinary = isBinaryBuffer(buffer)
  // Return base64 for recognized image formats so the renderer can display them
  const isPreviewableBinary = filePath
    ? !!PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
    : false
  return {
    content: isBinary
      ? isPreviewableBinary
        ? buffer.toString('base64')
        : ''
      : buffer.toString('utf-8'),
    isBinary,
    exists: true
  }
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192)
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}

function buildDiffResult(
  originalContent: string,
  modifiedContent: string,
  originalIsBinary: boolean,
  modifiedIsBinary: boolean,
  filePath?: string
): GitDiffResult {
  if (originalIsBinary || modifiedIsBinary) {
    const mimeType = filePath
      ? PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
      : undefined
    return {
      kind: 'binary',
      originalContent,
      modifiedContent,
      originalIsBinary,
      modifiedIsBinary,
      // Why: binary diff previews were originally image-only, so the renderer
      // still checks `isImage` before showing a preview component. Preserve
      // that legacy flag for PDFs until the wider contract is renamed.
      ...(mimeType ? { isImage: true, mimeType } : {})
    } as GitDiffResult
  }

  return {
    kind: 'text',
    originalContent,
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

type GitBlobReadResult = {
  content: string
  isBinary: boolean
  exists: boolean
}

const PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}

/**
 * Stage a file.
 */
export async function stageFile(worktreePath: string, filePath: string): Promise<void> {
  await gitExecFileAsync(['add', '--', filePath], { cwd: worktreePath })
}

/**
 * Unstage a file.
 */
export async function unstageFile(worktreePath: string, filePath: string): Promise<void> {
  await gitExecFileAsync(['restore', '--staged', '--', filePath], { cwd: worktreePath })
}

export async function commitChanges(
  worktreePath: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await gitExecFileAsync(['commit', '-m', message], { cwd: worktreePath })
    return { success: true }
  } catch (error) {
    // Why: surface whichever channel carries the useful message. Pre-commit/GPG
    // hook failures write to stderr; "nothing to commit, working tree clean"
    // writes to stdout. Try stderr first, fall back to stdout, then error.message.
    const readStringField = (field: string): string | null => {
      if (typeof error === 'object' && error && field in error) {
        const v = (error as Record<string, unknown>)[field]
        if (typeof v === 'string' && v.length > 0) {
          return v
        }
      }
      return null
    }
    const errorMessage =
      readStringField('stderr') ??
      readStringField('stdout') ??
      (error instanceof Error ? error.message : 'Commit failed')
    return { success: false, error: errorMessage }
  }
}

/**
 * Discard working tree changes for a file.
 */
export async function discardChanges(worktreePath: string, filePath: string): Promise<void> {
  const resolvedWorktree = path.resolve(worktreePath)
  const resolvedTarget = path.resolve(worktreePath, filePath)
  if (!isWithinWorktree(path, resolvedWorktree, resolvedTarget)) {
    throw new Error(`Path "${filePath}" resolves outside the worktree`)
  }

  let tracked = false
  try {
    await gitExecFileAsync(['ls-files', '--error-unmatch', '--', filePath], {
      cwd: worktreePath
    })
    tracked = true
  } catch {
    // File is not tracked by git
  }

  await (tracked
    ? gitExecFileAsync(['restore', '--worktree', '--source=HEAD', '--', filePath], {
        cwd: worktreePath
      })
    : rm(resolvedTarget, { force: true, recursive: true }))
}

export function isWithinWorktree(
  pathApi: Pick<typeof path, 'isAbsolute' | 'relative' | 'sep'>,
  resolvedWorktree: string,
  resolvedTarget: string
): boolean {
  const relativeTarget = pathApi.relative(resolvedWorktree, resolvedTarget)
  return !(
    relativeTarget === '' ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativeTarget)
  )
}

/**
 * Bulk stage files in batches to avoid E2BIG.
 */
export async function bulkStageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) {
    return
  }
  const CHUNK_SIZE = 100
  for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
    const chunk = filePaths.slice(i, i + CHUNK_SIZE)
    await gitExecFileAsync(['add', '--', ...chunk], { cwd: worktreePath })
  }
}

/**
 * Bulk unstage files in batches to avoid E2BIG.
 */
export async function bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) {
    return
  }
  const CHUNK_SIZE = 100
  for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
    const chunk = filePaths.slice(i, i + CHUNK_SIZE)
    await gitExecFileAsync(['restore', '--staged', '--', ...chunk], { cwd: worktreePath })
  }
}
