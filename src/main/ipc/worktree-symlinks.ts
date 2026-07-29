import { symlink, mkdir, stat, lstat, unlink, cp, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  ApfsCloneUnavailableError,
  canCloneWithApfs,
  cloneWorktreePathWithApfs,
  defaultApfsCloneDeps,
  WorktreeLinkedPathTargetExistsError,
  type ApfsCloneDeps,
  type DarwinFilesystemCache
} from './worktree-apfs-clone'
import {
  createWorktreeCopyBudgetTracker,
  type SkippedWorktreeCopyPath,
  type WorktreeCopyBudget
} from './worktree-include-copy-budget'
import {
  findExistingWorktreeSymlinkPaths,
  getSafeRelativePath
} from '../git/worktree-symlink-detection'

type WorktreeLinkedPathOptions = {
  platform?: NodeJS.Platform
  cloneWorktreePath?: (source: string, target: string, sourceIsDirectory: boolean) => Promise<void>
  apfsCloneDeps?: ApfsCloneDeps
  /** Copy-mode only. Overridable so tests can trip the bound without writing
   *  gigabytes to disk. */
  copyBudget?: WorktreeCopyBudget
}

// 'link': symlink when APFS clone is unavailable (user-configured shared paths).
// 'copy': real copy when APFS clone is unavailable (.worktreeinclude paths, which
// are per-worktree copies by cross-tool convention — edits must not leak back).
// 'share': always symlink (orca.yaml sharedDirectories). An APFS clone would give
// each worktree an independent node_modules, defeating one-install-serves-all.
type WorktreeMaterializeMode = 'link' | 'copy' | 'share'

/** The `fs.symlink` types to attempt, in order, for one materialized path.
 *
 *  Why more than one on Windows: a plain symlink needs Developer Mode or admin,
 *  so an ordinary Windows user gets EPERM and silently ends up with no shared
 *  directory at all. A directory junction needs no privilege, so try it first.
 *
 *  Why still fall back to a symlink: a junction cannot point at a UNC path, and
 *  a WSL project's repo lives behind one (`\\wsl.localhost\<Distro>\...`). The
 *  fallback keeps that case working exactly as it does today. */
export function worktreeSymlinkTypeCandidates(
  platform: NodeJS.Platform,
  sourceIsDirectory: boolean
): ('junction' | 'dir' | 'file')[] {
  if (!sourceIsDirectory) {
    return ['file']
  }
  return platform === 'win32' ? ['junction', 'dir'] : ['dir']
}

async function symlinkWorktreePath(
  source: string,
  target: string,
  sourceIsDirectory: boolean,
  platform: NodeJS.Platform
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  // Why: Windows requires an explicit `type` ('dir' vs 'file' vs 'junction')
  // for `fs.symlink`. On POSIX the argument is ignored, so passing it
  // unconditionally is safe and removes a Windows-only failure mode when Node
  // can't auto-detect from the source.
  const candidates = worktreeSymlinkTypeCandidates(platform, sourceIsDirectory)
  for (let index = 0; index < candidates.length; index++) {
    try {
      // Why: `source` is always absolute (`resolve()` guarantees it), which a
      // junction requires.
      await symlink(source, target, candidates[index])
      return
    } catch (error) {
      if (index === candidates.length - 1) {
        throw error
      }
    }
  }
}

async function copyWorktreePath(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  // Why: force=false + errorOnExist=false skips (not clobbers) anything a racing
  // process placed at the target after the earlier existence preflight.
  await cp(source, target, { recursive: true, force: false, errorOnExist: false })
}

/** An APFS clone was expected (so its bytes were never charged) but failed, and
 *  the byte-for-byte fallback would escape the budget. */
class WorktreeCopyBudgetFallbackError extends Error {
  constructor(target: string) {
    super(`APFS clone failed and a real copy of "${target}" would exceed the copy budget`)
    this.name = 'WorktreeCopyBudgetFallbackError'
  }
}

async function createWorktreeLinkedPath(
  source: string,
  copySource: string,
  target: string,
  sourceIsDirectory: boolean,
  sourceIsSymbolicLink: boolean,
  mode: WorktreeMaterializeMode,
  options: WorktreeLinkedPathOptions,
  apfsFilesystemCache: DarwinFilesystemCache,
  realCopyFallbackAllowed: () => boolean
): Promise<void> {
  // Why: share mode must never clone — an independent copy would give each
  // worktree its own node_modules, defeating one-install-serves-all.
  if (
    mode !== 'share' &&
    options.platform === 'darwin' &&
    (!sourceIsSymbolicLink || mode === 'copy')
  ) {
    try {
      const cloneWorktreePath =
        options.cloneWorktreePath ??
        ((cloneSource: string, cloneTarget: string, cloneSourceIsDirectory: boolean) =>
          cloneWorktreePathWithApfs(
            cloneSource,
            cloneTarget,
            cloneSourceIsDirectory,
            options.apfsCloneDeps ?? defaultApfsCloneDeps,
            apfsFilesystemCache
          ))
      await cloneWorktreePath(copySource, target, sourceIsDirectory)
      return
    } catch (error) {
      if (error instanceof WorktreeLinkedPathTargetExistsError) {
        return
      }
      // Why: APFS clone-copy can fail across volumes or on non-APFS disks.
      // Fall back per mode without touching any target path that may have
      // appeared after our preflight.
      if (!(error instanceof ApfsCloneUnavailableError)) {
        console.warn(`[worktree-symlinks] APFS clone-copy unavailable for "${target}":`, error)
        // Why: the fallback is a real byte-for-byte copy. If this entry was
        // admitted as a free clone its bytes were never charged, so bill them
        // now — and refuse if they no longer fit, rather than silently
        // reopening the unbounded copy this budget exists to close.
        if (mode === 'copy' && !realCopyFallbackAllowed()) {
          throw new WorktreeCopyBudgetFallbackError(target)
        }
      }
    }
  }
  if (mode === 'copy') {
    await copyWorktreePath(copySource, target)
    return
  }
  await symlinkWorktreePath(source, target, sourceIsDirectory, options.platform ?? process.platform)
}

/** Whether this copy will land as an APFS clone rather than a byte-for-byte
 *  copy. Only the volume probe can answer it, and that probe writes nothing. */
async function copyIsCopyOnWrite(
  source: string,
  worktreePath: string,
  options: WorktreeLinkedPathOptions,
  apfsFilesystemCache: DarwinFilesystemCache
): Promise<boolean> {
  if (options.platform !== 'darwin') {
    return false
  }
  // An injected clone stands in for the real one, so treat it as cloning —
  // probing the real filesystem here would make these tests host-dependent.
  if (options.cloneWorktreePath) {
    return true
  }
  return await canCloneWithApfs(
    source,
    worktreePath,
    options.apfsCloneDeps ?? defaultApfsCloneDeps,
    apfsFilesystemCache
  )
}

async function targetExists(target: string): Promise<boolean> {
  try {
    // Why: lstat so a pre-existing symlink (even a broken one) is detected and
    // preserved rather than overwritten.
    await lstat(target)
    return true
  } catch {
    return false
  }
}

async function materializeWorktreePaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  mode: WorktreeMaterializeMode,
  options: WorktreeLinkedPathOptions = {}
): Promise<SkippedWorktreeCopyPath[]> {
  const effectiveOptions = { platform: process.platform, ...options }
  // Why: one df+diskutil probe per distinct volume for the whole materialization,
  // not per copied path — see DarwinFilesystemCache.
  const apfsFilesystemCache: DarwinFilesystemCache = new Map()
  // Why: one budget for the whole materialization, so a hundred medium entries
  // are refused for the same reason one `node_modules` entry is.
  const copyBudget = createWorktreeCopyBudgetTracker(options.copyBudget)
  const skipped: SkippedWorktreeCopyPath[] = []

  for (const rawPath of paths) {
    const safePath = getSafeRelativePath(rawPath)
    if (!safePath.safe) {
      // Users can only configure paths relative to the repo root; absolute
      // paths and `..` traversal are not supported.
      console.warn(`[worktree-symlinks] Skipping unsafe path "${rawPath}"`)
      continue
    }

    const source = resolve(primaryPath, safePath.rel)
    const target = resolve(worktreePath, safePath.rel)

    let sourceIsDirectory = false
    let sourceIsSymbolicLink = false
    try {
      sourceIsSymbolicLink = (await lstat(source)).isSymbolicLink()
      const s = await stat(source)
      sourceIsDirectory = s.isDirectory()
    } catch {
      // Source doesn't exist in primary checkout — nothing to link to. This is
      // a common case for fresh clones where `node_modules` hasn't been
      // installed yet; silently skip rather than leaving a dangling symlink.
      continue
    }

    if (await targetExists(target)) {
      continue
    }

    // Why: copy mode promises each worktree an independent copy; copying the
    // symlink itself would recreate a link to the shared target, so edits in the
    // worktree would leak back into the primary checkout (or escape it entirely if
    // the link points outside). Resolve the real source so we copy content.
    let copySource = source
    let bytesAreCopied = true
    let measuredBytes = 0
    if (mode === 'copy') {
      try {
        if (sourceIsSymbolicLink) {
          copySource = await realpath(source)
        }
        // Why: an APFS clone is copy-on-write — a 2.7 GB tree clones in ~20ms
        // and consumes no disk — so bytes are not the cost there, inodes are.
        // Charging bytes on that path would refuse work that is already free.
        bytesAreCopied = !(await copyIsCopyOnWrite(
          copySource,
          worktreePath,
          effectiveOptions,
          apfsFilesystemCache
        ))
        const verdict = await copyBudget.admit(copySource, { bytesAreCopied })
        if (!verdict.withinBudget) {
          // Why: refuse before the first byte is written. Aborting mid-copy is
          // not available (`fs.cp` ignores its `signal`) and would strand a
          // partial tree; the caller surfaces this as a create warning.
          skipped.push({ path: safePath.rel, reason: verdict.reason })
          console.warn(
            `[worktree-symlinks] Skipping "${safePath.rel}": copy exceeds the worktree copy budget (${verdict.reason})`
          )
          continue
        }
        measuredBytes = verdict.bytes
      } catch (error) {
        console.error(`[worktree-symlinks] Failed to size "${safePath.rel}" (${source}):`, error)
        continue
      }
    }

    try {
      await createWorktreeLinkedPath(
        source,
        copySource,
        target,
        sourceIsDirectory,
        sourceIsSymbolicLink,
        mode,
        effectiveOptions,
        apfsFilesystemCache,
        () => bytesAreCopied || copyBudget.chargeBytes(measuredBytes)
      )
    } catch (error) {
      if (error instanceof WorktreeCopyBudgetFallbackError) {
        // Why: a directory clone reserves the target and only removes it when
        // it is still *empty*, so leftovers can survive. A file clone publishes
        // from a temp path with link(2), so a failure leaves nothing behind.
        skipped.push({
          path: safePath.rel,
          reason: 'bytes',
          ...(sourceIsDirectory ? { mayBePartial: true } : {})
        })
        console.warn(`[worktree-symlinks] Skipping "${safePath.rel}": ${error.message}`)
        continue
      }
      console.error(
        `[worktree-symlinks] Failed to link "${safePath.rel}" (${source} -> ${target}):`,
        error
      )
    }
  }
  return skipped
}

export async function createWorktreeLinkedPaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  options: WorktreeLinkedPathOptions = {}
): Promise<void> {
  await materializeWorktreePaths(primaryPath, worktreePath, paths, 'link', options)
}

/** Copy `.worktreeinclude`-resolved paths from the primary checkout into a
 *  freshly-created worktree. Same per-path failure isolation as
 *  createWorktreeLinkedPaths, but the non-APFS fallback is a real copy, never a
 *  symlink: the convention promises each worktree its own private copy.
 *
 *  Returns the entries refused by the copy budget so worktree creation can
 *  surface them — a workspace quietly missing its included files is worse than
 *  one that says which entries it left behind. */
export async function createWorktreeCopiedPaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  options: WorktreeLinkedPathOptions = {}
): Promise<SkippedWorktreeCopyPath[]> {
  return await materializeWorktreePaths(primaryPath, worktreePath, paths, 'copy', options)
}

/** Symlink `orca.yaml` `worktree.sharedDirectories` into a freshly-created
 *  worktree. Unlike createWorktreeLinkedPaths this never APFS clone-copies: a
 *  clone would give each worktree its own node_modules, and the point of a
 *  shared directory is that one install serves every worktree. */
export async function createWorktreeSharedPaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  options: WorktreeLinkedPathOptions = {}
): Promise<void> {
  await materializeWorktreePaths(primaryPath, worktreePath, paths, 'share', options)
}

/** Create filesystem symlinks from the primary checkout into a freshly-created
 *  worktree for each configured path. Failures on individual paths are logged
 *  and skipped so a missing/stale entry never blocks worktree creation.
 *
 *  Each entry is interpreted relative to `primaryPath` and placed at the same
 *  relative location inside `worktreePath`. Nested paths (e.g.
 *  `apps/web/.env`) are supported — parent directories are created lazily. */
export async function createWorktreeSymlinks(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[]
): Promise<void> {
  await createWorktreeLinkedPaths(primaryPath, worktreePath, paths, { platform: 'linux' })
}

export async function removeWorktreeLinkedPaths(
  worktreePath: string,
  paths: readonly string[]
): Promise<void> {
  for (const rawPath of paths) {
    const safePath = getSafeRelativePath(rawPath)
    if (!safePath.safe) {
      continue
    }
    const target = resolve(worktreePath, safePath.rel)
    try {
      const s = await lstat(target)
      if (s.isSymbolicLink()) {
        await unlink(target)
      }
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'ENOENT') {
        console.error(`[worktree-symlinks] Failed to remove "${safePath.rel}" (${target}):`, error)
      }
    }
  }
}

export { findExistingWorktreeSymlinkPaths }

/** Remove previously-created symlinks from a worktree before deletion.
 *
 *  Why: `git worktree remove` refuses to delete a worktree that has modified
 *  or untracked files. A symlink pointing at the primary's `node_modules`
 *  looks "untracked" to git, so users would hit "It has changed files. Use
 *  Force Delete" on every deletion once they've configured this feature.
 *  Unlink the known symlinks up front so the non-force path keeps working.
 *
 *  Safety: only removes entries that are actually symbolic links. A regular
 *  file or directory at the same path is left alone — we never want to clobber
 *  something the user created that happens to share a name with a configured
 *  entry. Missing entries (ENOENT) are silently ignored. */
export async function removeWorktreeSymlinks(
  worktreePath: string,
  paths: readonly string[]
): Promise<void> {
  await removeWorktreeLinkedPaths(worktreePath, paths)
}
