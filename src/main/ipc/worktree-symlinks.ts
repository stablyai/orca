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
  copyBudget?: WorktreeCopyBudget
}

// link prefers APFS clone then symlink; copy requires independent content; share always links so one install serves all worktrees.
type WorktreeMaterializeMode = 'link' | 'copy' | 'share'

/** Try privilege-free Windows junctions first, retaining symlink fallback for UNC targets such as WSL. */
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
  // Windows needs an explicit link type; POSIX safely ignores it.
  const candidates = worktreeSymlinkTypeCandidates(platform, sourceIsDirectory)
  for (let index = 0; index < candidates.length; index++) {
    try {
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
  // Preserve targets created by racing processes after preflight.
  await cp(source, target, { recursive: true, force: false, errorOnExist: false })
}

/** Predicted clone failed and a real-copy fallback would exceed the byte budget. */
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
      // Fall back per mode on unavailable/cross-volume cloning, preserving targets created since preflight.
      if (!(error instanceof ApfsCloneUnavailableError)) {
        console.warn(`[worktree-symlinks] APFS clone-copy unavailable for "${target}":`, error)
        // Predicted clones skipped byte charges; bill real-copy fallback before allowing it.
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

/** Probe copy-on-write eligibility without writing, so clone bytes can remain uncharged. */
async function copyIsCopyOnWrite(
  source: string,
  worktreePath: string,
  options: WorktreeLinkedPathOptions,
  apfsFilesystemCache: DarwinFilesystemCache
): Promise<boolean> {
  if (options.platform !== 'darwin') {
    return false
  }
  // Injected clones avoid host-dependent filesystem probes in tests.
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
    // lstat preserves even broken preexisting symlinks.
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
  // Share volume probes across the entire materialization.
  const apfsFilesystemCache: DarwinFilesystemCache = new Map()
  const copyBudget = createWorktreeCopyBudgetTracker(options.copyBudget)
  const skipped: SkippedWorktreeCopyPath[] = []

  for (const rawPath of paths) {
    const safePath = getSafeRelativePath(rawPath)
    if (!safePath.safe) {
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
      // Missing source is normal on fresh clones; do not leave a dangling link.
      continue
    }

    if (await targetExists(target)) {
      continue
    }

    // Copy-mode entries must own their content; dereference top-level symlinks so edits cannot reach shared targets.
    let copySource = source
    let bytesAreCopied = true
    let measuredBytes = 0
    if (mode === 'copy') {
      try {
        if (sourceIsSymbolicLink) {
          copySource = await realpath(source)
        }
        // Clones incur entry work without byte-copy cost; charge only actual byte-for-byte copying.
        bytesAreCopied = !(await copyIsCopyOnWrite(
          copySource,
          worktreePath,
          effectiveOptions,
          apfsFilesystemCache
        ))
        const verdict = await copyBudget.admit(copySource, { bytesAreCopied })
        if (!verdict.withinBudget) {
          // Refuse before copying: fs.cp cannot cancel mid-copy and would leave partial content.
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
        // Failed directory clones can leave reserved contents; file clone publication leaves no partial target.
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

/** Copy includes independently, isolate per-path failures, and report budget refusals to the creator. */
export async function createWorktreeCopiedPaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  options: WorktreeLinkedPathOptions = {}
): Promise<SkippedWorktreeCopyPath[]> {
  return await materializeWorktreePaths(primaryPath, worktreePath, paths, 'copy', options)
}

/** Shared directories always link; cloning would defeat one-install-for-all dependency sharing. */
export async function createWorktreeSharedPaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  options: WorktreeLinkedPathOptions = {}
): Promise<void> {
  await materializeWorktreePaths(primaryPath, worktreePath, paths, 'share', options)
}

/** Link configured relative paths, creating nested parents and isolating per-path failures. */
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

/** Unlink configured symlinks before Git removal so shared paths do not look untracked.
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
