import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { symlink, mkdir, stat, lstat, unlink, rm, link, rmdir, chmod } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

type ExecFileAsync = (
  file: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>

const execFileAsync = promisify(execFile) as ExecFileAsync

type ApfsCloneDeps = {
  execFileAsync: ExecFileAsync
  randomUUID: () => string
}

const defaultApfsCloneDeps: ApfsCloneDeps = {
  execFileAsync,
  randomUUID
}

type WorktreeLinkedPathOptions = {
  platform?: NodeJS.Platform
  cloneWorktreePath?: (source: string, target: string, sourceIsDirectory: boolean) => Promise<void>
  apfsCloneDeps?: ApfsCloneDeps
}

type SafeRelativePathResult =
  | {
      safe: true
      rel: string
    }
  | {
      safe: false
    }

type DarwinFilesystemInfo = {
  device: string
  filesystemName: string
}

class ApfsCloneUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApfsCloneUnavailableError'
  }
}

class WorktreeLinkedPathTargetExistsError extends Error {
  constructor(target: string) {
    super(`Worktree linked path target already exists: ${target}`)
    this.name = 'WorktreeLinkedPathTargetExistsError'
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'EEXIST'
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

async function targetExists(target: string): Promise<boolean> {
  try {
    // Why: use lstat so a pre-existing symlink (including a broken one whose
    // source has moved) is detected and skipped instead of overwritten.
    await lstat(target)
    return true
  } catch {
    return false
  }
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

async function getDarwinFilesystemInfo(
  path: string,
  deps: ApfsCloneDeps
): Promise<DarwinFilesystemInfo> {
  const { stdout: dfOutput } = await deps.execFileAsync('/bin/df', ['-P', path])
  const device = dfOutput.trim().split(/\r?\n/)[1]?.trim().split(/\s+/)[0]
  if (!device) {
    throw new Error(`Could not resolve filesystem device for ${path}`)
  }
  const { stdout: diskutilOutput } = await deps.execFileAsync('/usr/sbin/diskutil', [
    'info',
    '-plist',
    device
  ])
  const filesystemNameMatch = /<key>FilesystemName<\/key>\s*<string>([^<]+)<\/string>/u.exec(
    diskutilOutput
  )
  return {
    device,
    filesystemName: filesystemNameMatch?.[1] ?? ''
  }
}

async function assertSameApfsVolume(
  source: string,
  target: string,
  deps: ApfsCloneDeps
): Promise<void> {
  const [sourceInfo, targetInfo] = await Promise.all([
    getDarwinFilesystemInfo(source, deps),
    getDarwinFilesystemInfo(dirname(target), deps)
  ])
  if (
    sourceInfo.device !== targetInfo.device ||
    sourceInfo.filesystemName !== 'APFS' ||
    targetInfo.filesystemName !== 'APFS'
  ) {
    throw new ApfsCloneUnavailableError(
      'APFS clone-copy requires source and target on the same APFS volume'
    )
  }
}

async function cloneFileWithApfs(
  source: string,
  target: string,
  deps: ApfsCloneDeps
): Promise<void> {
  const tempTarget = resolve(dirname(target), `.orca-apfs-clone-${deps.randomUUID()}`)
  try {
    await deps.execFileAsync('/bin/cp', ['-c', source, tempTarget])
    try {
      // Why: link(2) is an atomic no-clobber publish for files; rename(2) can
      // overwrite a target that appeared after the earlier existence check.
      await link(tempTarget, target)
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new WorktreeLinkedPathTargetExistsError(target)
      }
      throw error
    }
  } finally {
    await rm(tempTarget, { force: true }).catch(() => undefined)
  }
}

async function cloneDirectoryWithApfs(
  source: string,
  target: string,
  deps: ApfsCloneDeps
): Promise<void> {
  const sourceMode = (await stat(source)).mode & 0o777
  try {
    // Why: reserve the final directory path before copying into it so a raced
    // user-created directory cannot be replaced by a final rename.
    await mkdir(target)
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new WorktreeLinkedPathTargetExistsError(target)
    }
    throw error
  }

  try {
    // Why: the top-level directory is reserved before cp runs, so use `-n`
    // to keep a raced nested file from being overwritten during the copy.
    await deps.execFileAsync('/bin/cp', ['-n', '-c', '-R', source, dirname(target)])
    await chmod(target, sourceMode)
  } catch (error) {
    // Why: remove only the empty reservation. If cp wrote anything, or another
    // process raced files into the directory, leave it for Git/user review.
    await rmdir(target).catch(() => undefined)
    throw error
  }
}

async function cloneWorktreePathWithApfs(
  source: string,
  target: string,
  sourceIsDirectory: boolean,
  deps: ApfsCloneDeps = defaultApfsCloneDeps
): Promise<void> {
  const targetParent = dirname(target)
  await mkdir(targetParent, { recursive: true })
  await assertSameApfsVolume(source, target, deps)
  // Why: Node's COPYFILE_FICLONE_FORCE returns ENOSYS on macOS in our runtime,
  // while Darwin's cp exposes APFS clonefile via -c. Preflight the volume so
  // cp's non-APFS full-copy fallback cannot surprise users.
  await (sourceIsDirectory ? cloneDirectoryWithApfs : cloneFileWithApfs)(source, target, deps)
}

async function createWorktreeLinkedPath(
  source: string,
  target: string,
  sourceIsDirectory: boolean,
  sourceIsSymbolicLink: boolean,
  options: WorktreeLinkedPathOptions
): Promise<void> {
  if (options.platform === 'darwin' && !sourceIsSymbolicLink) {
    try {
      const cloneWorktreePath =
        options.cloneWorktreePath ??
        ((cloneSource: string, cloneTarget: string, cloneSourceIsDirectory: boolean) =>
          cloneWorktreePathWithApfs(
            cloneSource,
            cloneTarget,
            cloneSourceIsDirectory,
            options.apfsCloneDeps ?? defaultApfsCloneDeps
          ))
      await cloneWorktreePath(source, target, sourceIsDirectory)
      return
    } catch (error) {
      if (error instanceof WorktreeLinkedPathTargetExistsError) {
        return
      }
      // Why: APFS clone-copy can fail across volumes or on non-APFS disks.
      // Fall back to the historical symlink behavior without touching any
      // target path that may have appeared after our preflight.
      if (!(error instanceof ApfsCloneUnavailableError)) {
        console.warn(`[worktree-symlinks] APFS clone-copy unavailable for "${target}":`, error)
      }
    }
  }
  await symlinkWorktreePath(source, target, sourceIsDirectory)
}

export async function createWorktreeLinkedPaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  options: WorktreeLinkedPathOptions = {}
): Promise<void> {
  const effectiveOptions = { platform: process.platform, ...options }

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
        effectiveOptions
      )
    } catch (error) {
      console.error(
        `[worktree-symlinks] Failed to link "${safePath.rel}" (${source} -> ${target}):`,
        error
      )
    }
  }
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
