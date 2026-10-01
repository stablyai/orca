import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { detectSparseCheckoutInGitDir } from '../worktree-sparse-state'
import type { AdminStatDependency } from './admin-stat-signature'
import type { RepoConfigFacts } from './repo-admin-layout'
import {
  parseRefFileContent,
  readTrimmedAdminFile,
  resolveRefToOid,
  UNREADABLE,
  type PackedRefLookup,
  type RefResolutionTrace
} from './worktree-admin-file-reads'
import { getErrorCode } from '../worktree-operation-options'

// These rules reproduce what `git worktree list --porcelain` prints for the layouts they accept.
// Anything outside them throws WorktreeRowsNeedGit and the model asks Git instead.

export class WorktreeRowsNeedGit extends Error {
  constructor(
    readonly reason: string,
    /** True for an I/O failure worth retrying from files; false for a layout the rules reject. */
    readonly transient: boolean
  ) {
    super(`worktree rows need git: ${reason}`)
  }
}

// Git's English wording; Orca reads only the `prunable` flag, never this text.
export const PRUNABLE_REASON = 'gitdir file points to non-existent location'

export type FileRowContext = {
  commonDir: string
  facts: RepoConfigFacts
  packedRef: PackedRefLookup
  platform: NodeJS.Platform
}

export type DerivedFileRow = {
  /** Null when Git would skip the entry (no readable, non-empty `gitdir`). */
  row: GitWorktreeInfo | null
  dependencies: AdminStatDependency[]
  usedPackedRefs: boolean
}

const GIT_WHITESPACE = /[ \t\n\v\f\r]+$/
const PER_WORKTREE_REF = /^refs\/(?:worktree|bisect|rewritten)\//

/** Git's `check_refname_format` for the names a HEAD can point at. */
export function isGitRefNameFormat(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.endsWith('/') || ref.endsWith('.') || ref.includes('@{')) {
    return false
  }
  // eslint-disable-next-line no-control-regex -- Git rejects control characters in ref names.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) {
    return false
  }
  return ref
    .split('/')
    .every(
      (part) =>
        part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock') && !part.includes('..')
    )
}

function isGitAbsolutePath(path: string, platform: NodeJS.Platform): boolean {
  // Git for Windows also counts a drive prefix (`C:`) and either separator as absolute.
  return platform === 'win32' ? /^(?:[A-Za-z]:|[\\/])/.test(path) : path.startsWith('/')
}

async function readRawAdminFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = getErrorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    throw new WorktreeRowsNeedGit(`unreadable ${path}`, true)
  }
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch (error) {
    const code = getErrorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false
    }
    throw new WorktreeRowsNeedGit(`unreadable ${path}`, true)
  }
}

async function pathExistsNoFollow(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    const code = getErrorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false
    }
    throw new WorktreeRowsNeedGit(`unreadable ${path}`, true)
  }
}

type HeadFields = { head: string; branch: string; trace: RefResolutionTrace }

/** Git's `add_head_info`: a missing or empty HEAD prints the zero id and no branch. */
async function readHeadFields(context: FileRowContext, headPath: string): Promise<HeadFields> {
  const trace: RefResolutionTrace = { looseRefPaths: [], usedPackedRefs: false }
  const zeroId = '0'.repeat(context.facts.objectIdLength)
  // Git reads a symlinked HEAD (`core.preferSymlinkRefs`) as a symref to the link's target name.
  if (await isSymbolicLink(headPath)) {
    throw new WorktreeRowsNeedGit(`symlinked HEAD ${headPath}`, false)
  }
  const content = await readTrimmedAdminFile(headPath)
  if (content === UNREADABLE) {
    throw new WorktreeRowsNeedGit(`unreadable ${headPath}`, true)
  }
  if (!content) {
    return { head: zeroId, branch: '', trace }
  }
  const parsed = parseRefFileContent(content)
  if ('garbage' in parsed) {
    throw new WorktreeRowsNeedGit(`unrecognized HEAD ${headPath}`, false)
  }
  if ('oid' in parsed) {
    return { head: checkedObjectId(context, parsed.oid), branch: '', trace }
  }
  if (!isGitRefNameFormat(parsed.symref) || PER_WORKTREE_REF.test(parsed.symref)) {
    throw new WorktreeRowsNeedGit(`HEAD names ${parsed.symref}`, false)
  }
  const resolved = await resolveRefToOid(context.commonDir, parsed.symref, context.packedRef, trace)
  if (resolved === UNREADABLE) {
    throw new WorktreeRowsNeedGit(`unreadable ref ${parsed.symref}`, true)
  }
  if (
    resolved.ref === null ||
    !isGitRefNameFormat(resolved.ref) ||
    PER_WORKTREE_REF.test(resolved.ref)
  ) {
    throw new WorktreeRowsNeedGit(`unresolvable ref ${parsed.symref}`, false)
  }
  // An unborn branch keeps its name with the zero id, exactly as Git prints it.
  const head = resolved.oid === null ? zeroId : checkedObjectId(context, resolved.oid)
  return { head, branch: resolved.ref, trace }
}

function checkedObjectId(context: FileRowContext, oid: string): string {
  if (oid.length !== context.facts.objectIdLength) {
    throw new WorktreeRowsNeedGit('object id length does not match the object format', false)
  }
  return oid
}

function headDependencies(gitDir: string, trace: RefResolutionTrace): AdminStatDependency[] {
  return [{ path: join(gitDir, 'HEAD') }, ...trace.looseRefPaths.map((path) => ({ path }))]
}

/** One linked worktree's row from `worktrees/<name>/`, as Git's `get_linked_worktree` reads it. */
export async function readLinkedEntryRow(
  context: FileRowContext,
  entryName: string
): Promise<DerivedFileRow> {
  const entryDir = join(context.commonDir, 'worktrees', entryName)
  const baseDependencies: AdminStatDependency[] = [
    { path: entryDir },
    { path: join(entryDir, 'gitdir') }
  ]
  const rawGitdir = await readRawAdminFile(join(entryDir, 'gitdir'))
  if (!rawGitdir) {
    return { row: null, dependencies: baseDependencies, usedPackedRefs: false }
  }
  const recorded = rawGitdir.replace(GIT_WHITESPACE, '')
  // Git realpaths a relative record, which only Git can reproduce byte for byte.
  if (!isGitAbsolutePath(recorded, context.platform)) {
    throw new WorktreeRowsNeedGit('relative gitdir', false)
  }
  const worktreePath = recorded.endsWith('/.git') ? recorded.slice(0, -'/.git'.length) : recorded
  // `should_prune_worktree` strips only line endings before probing the checkout's `.git`.
  const checkoutDotGit = rawGitdir.replace(/[\r\n]+$/, '')
  const [headFields, lockContent] = await Promise.all([
    readHeadFields(context, join(entryDir, 'HEAD')),
    readRawAdminFile(join(entryDir, 'locked'))
  ])
  const locked = lockContent !== null
  const prunable = !locked && !(await pathExistsNoFollow(checkoutDotGit))
  const isSparse = !prunable && (await detectSparseCheckoutInGitDir(entryDir, context.facts))
  const lockReason = lockContent?.trim()
  return {
    row: {
      path: worktreePath,
      head: headFields.head,
      branch: headFields.branch,
      isBare: false,
      ...(isSparse ? { isSparse } : {}),
      ...(locked ? { locked: true } : {}),
      ...(lockReason ? { lockReason } : {}),
      ...(prunable ? { prunable: true, prunableReason: PRUNABLE_REASON } : {}),
      isMainWorktree: false
    },
    dependencies: [
      ...baseDependencies,
      ...headDependencies(entryDir, headFields.trace),
      { path: checkoutDotGit, noFollow: true }
    ],
    usedPackedRefs: headFields.trace.usedPackedRefs
  }
}

/** The main row, with its path and bareness taken from Git (see the model's baseline). */
export async function readMainRow(
  context: FileRowContext,
  main: { path: string; isBare: boolean }
): Promise<DerivedFileRow> {
  const commonDirDependency: AdminStatDependency = { path: context.commonDir }
  if (main.isBare) {
    return {
      row: { path: main.path, head: '', branch: '', isBare: true, isMainWorktree: true },
      dependencies: [commonDirDependency],
      usedPackedRefs: false
    }
  }
  const headFields = await readHeadFields(context, join(context.commonDir, 'HEAD'))
  const isSparse = await detectSparseCheckoutInGitDir(context.commonDir, context.facts)
  return {
    row: {
      path: main.path,
      head: headFields.head,
      branch: headFields.branch,
      isBare: false,
      ...(isSparse ? { isSparse } : {}),
      isMainWorktree: true
    },
    // The common dir moves on every index write in the main checkout, which is what a sparse
    // toggle there rewrites; re-reading the main row for it costs a handful of small reads.
    dependencies: [commonDirDependency, ...headDependencies(context.commonDir, headFields.trace)],
    usedPackedRefs: headFields.trace.usedPackedRefs
  }
}

const utf8 = (value: string): Buffer => Buffer.from(value, 'utf8')

/** Git's `pathsort`: bytewise, folding only ASCII case when `core.ignorecase` is set. */
export function compareWorktreePathsLikeGit(
  left: string,
  right: string,
  ignoreCase: boolean
): number {
  const fold = (value: string): string =>
    ignoreCase ? value.replace(/[A-Z]/g, (c) => c.toLowerCase()) : value
  return Buffer.compare(utf8(fold(left)), utf8(fold(right)))
}
