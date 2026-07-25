import { symlink, mkdir, stat, lstat, unlink, cp, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  ApfsCloneUnavailableError,
  cloneWorktreePathWithApfs,
  defaultApfsCloneDeps,
  WorktreeLinkedPathTargetExistsError,
  type ApfsCloneDeps,
  type DarwinFilesystemCache
} from './worktree-apfs-clone'

type WorktreeLinkedPathOptions = {
  platform?: NodeJS.Platform
  cloneWorktreePath?: (source: string, target: string, sourceIsDirectory: boolean) => Promise<void>
  apfsCloneDeps?: ApfsCloneDeps
}

// 'link': symlink when APFS clone is unavailable (user-configured shared paths).
// 'copy': real copy when APFS clone is unavailable (.worktreeinclude paths, which
// are per-worktree copies by cross-tool convention — edits must not leak back).
type WorktreeMaterializeMode = 'link' | 'copy'

type SafeRelativePathResult =
  | {
      safe: true
      rel: string
    }
  | {
      safe: false
    }

function getSafeRelativePath(rawPath: string): SafeRelativePathResult {
  // Why: strip leading separators (both `/` and `\`) before the guard so
  // Windows-style input like `\foo` is normalized the same way POSIX `/foo`
  // is, and the traversal check below sees the already-relative form.
  const rel = rawPath.trim().replace(/^[\\/]+/, '')
  // Why: split on both separators so a Windows-authored `..\escape` is
  // rejected the same way POSIX `../escape` is. `path.isAbsolute` catches
  // drive-letter absolutes (`C:\...`); the split catches relative
  // backslash traversal that `.split('/')` would otherwise miss.
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    return { safe: false }
  }
  return { safe: true, rel }
}

async function symlinkWorktreePath(
  source: string,
  target: string,
  sourceIsDirectory: boolean
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  // Why: Windows requires an explicit `type` ('dir' vs 'file' vs
  // 'junction') for `fs.symlink`. On POSIX the argument is ignored, so
  // passing it unconditionally is safe and removes a Windows-only
  // failure mode when Node can't auto-detect from the source.
  await symlink(source, target, sourceIsDirectory ? 'dir' : 'file')
}

async function copyWorktreePath(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  // Why: force=false + errorOnExist=false skips (not clobbers) anything a racing
  // process placed at the target after the earlier existence preflight.
  await cp(source, target, { recursive: true, force: false, errorOnExist: false })
}

async function createWorktreeLinkedPath(
  source: string,
  target: string,
  sourceIsDirectory: boolean,
  sourceIsSymbolicLink: boolean,
  mode: WorktreeMaterializeMode,
  options: WorktreeLinkedPathOptions,
  apfsFilesystemCache: DarwinFilesystemCache
): Promise<void> {
  // Why: copy mode promises each worktree an independent copy; copying the
  // symlink itself would recreate a link to the shared target, so edits in the
  // worktree would leak back into the primary checkout (or escape it entirely if
  // the link points outside). Resolve the real source so we copy content.
  const copySource = mode === 'copy' && sourceIsSymbolicLink ? await realpath(source) : source
  if (options.platform === 'darwin' && (!sourceIsSymbolicLink || mode === 'copy')) {
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
      }
    }
  }
  if (mode === 'copy') {
    await copyWorktreePath(copySource, target)
    return
  }
  await symlinkWorktreePath(source, target, sourceIsDirectory)
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
): Promise<void> {
  const effectiveOptions = { platform: process.platform, ...options }
  // Why: one df+diskutil probe per distinct volume for the whole materialization,
  // not per copied path — see DarwinFilesystemCache.
  const apfsFilesystemCache: DarwinFilesystemCache = new Map()

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

    try {
      await createWorktreeLinkedPath(
        source,
        target,
        sourceIsDirectory,
        sourceIsSymbolicLink,
        mode,
        effectiveOptions,
        apfsFilesystemCache
      )
    } catch (error) {
      console.error(
        `[worktree-symlinks] Failed to link "${safePath.rel}" (${source} -> ${target}):`,
        error
      )
    }
  }
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
 *  symlink: the convention promises each worktree its own private copy. */
export async function createWorktreeCopiedPaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  options: WorktreeLinkedPathOptions = {}
): Promise<void> {
  await materializeWorktreePaths(primaryPath, worktreePath, paths, 'copy', options)
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

export async function findExistingWorktreeSymlinkPaths(
  worktreePath: string,
  paths: readonly string[]
): Promise<string[]> {
  const symlinkPaths: string[] = []
  for (const rawPath of paths) {
    const safePath = getSafeRelativePath(rawPath)
    if (!safePath.safe) {
      continue
    }
    try {
      if ((await lstat(resolve(worktreePath, safePath.rel))).isSymbolicLink()) {
        symlinkPaths.push(safePath.rel)
      }
    } catch {
      // Why: only a positively identified symlink may bypass dirty preflight.
    }
  }
  return symlinkPaths
}

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
