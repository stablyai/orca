import { randomUUID } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { chmod, copyFile, link, mkdir, mkdtemp, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { removeWorktreeCloneStaging } from './worktree-clone-staging'
import { runWorktreeCloneProcess } from './worktree-clone-process'
import {
  isAlreadyExistsError,
  WorktreeCloneUnavailableError,
  WorktreeCloneInterruptedError,
  WorktreeClonePartialError,
  WorktreeLinkedPathTargetExistsError
} from './worktree-clone-copy-errors'

export type ReflinkCloneDeps = {
  /** The probe: `FICLONE` or nothing. Must throw rather than copy bytes when
   *  the filesystem cannot share blocks. */
  reflinkFileOrFail: (source: string, target: string) => Promise<void>
  /** Must throw when this file cannot share blocks, even after a successful probe. */
  reflinkFile: (source: string, target: string) => Promise<void>
  /** Recursive reflink of a directory's contents into an existing `target`
   *  that skips (never clobbers) whatever is already there. */
  reflinkTree: (source: string, target: string) => Promise<void>
  /** Publish an already private tree without copying bytes or replacing files. */
  publishTree: (source: string, target: string) => Promise<void>
  randomUUID: () => string
}

// Automatic byte fallback would bypass the materialization's copy budget.
export const defaultReflinkCloneDeps: ReflinkCloneDeps = {
  reflinkFileOrFail: (source, target) => copyFile(source, target, constants.COPYFILE_FICLONE_FORCE),
  reflinkFile: (source, target) => copyFile(source, target, constants.COPYFILE_FICLONE_FORCE),
  reflinkTree: async (source, target) => {
    // Why `-n`: the target directory is reserved before this runs, so a raced
    // nested file must be kept, not overwritten. `--update=none` is the modern
    // spelling but coreutils 8.x (Ubuntu 20.04) only knows `-n`.
    // Why `source/.`: contents land at the requested path even when the source
    // is a symlinked directory.
    const result = await runWorktreeCloneProcess({
      program: '/bin/cp',
      args: ['-n', '-R', '--reflink=always', `${source}${sep}.`, target],
      timeoutMs: null
    })
    if (result.code !== 0) {
      throw new Error(
        `cp --reflink exited ${result.code ?? result.signal ?? 'unknown'}: ${result.stderr.trim()}`
      )
    }
  },
  publishTree: async (source, target) => {
    const result = await runWorktreeCloneProcess({
      program: '/bin/cp',
      args: ['-n', '-R', '-P', '--link', '--preserve=mode,timestamps', `${source}${sep}.`, target],
      timeoutMs: null
    })
    if (result.code !== 0) {
      throw new Error(`cp --link exited ${result.code ?? result.signal}: ${result.stderr.trim()}`)
    }
  },
  randomUUID
}

/** Advisory prediction per filesystem pair; every actual clone must still be strict. */
export type ReflinkFilesystemCache = Map<string, Promise<boolean>>

// Why: the probe reflinks one real file, so it needs one with bytes in it. A
// source holding only empty files and directories costs the same either way.
const PROBE_FILE_SEARCH_LIMIT = 256

async function findProbeFile(source: string): Promise<string | null> {
  const sourceStats = await stat(source)
  if (sourceStats.isFile()) {
    return sourceStats.size > 0 ? source : null
  }
  if (!sourceStats.isDirectory()) {
    return null
  }
  const pending = [source]
  let seen = 0
  while (pending.length > 0) {
    const directory = pending.shift() as string
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (seen++ >= PROBE_FILE_SEARCH_LIMIT) {
        return null
      }
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(entryPath)
        continue
      }
      // Why: the tree clone reproduces a symlink as a symlink, never through it.
      if (!entry.isFile()) {
        continue
      }
      try {
        if ((await stat(entryPath)).size > 0) {
          return entryPath
        }
      } catch {
        // Raced away between readdir and now — the clone will skip it too.
      }
    }
  }
  return null
}

async function probeReflink(
  probeSource: string,
  targetDirectory: string,
  deps: ReflinkCloneDeps
): Promise<boolean> {
  const staging = await mkdtemp(join(targetDirectory, '.orca-reflink-probe-'))
  const probeTarget = join(staging, 'file')
  try {
    await deps.reflinkFileOrFail(probeSource, probeTarget)
    return true
  } catch {
    // A transient refusal is not evidence that these particular bytes will clone.
    return false
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function filesystemPairKey(source: string, targetDirectory: string): Promise<string> {
  const [sourceStats, targetStats] = await Promise.all([stat(source), stat(targetDirectory)])
  return `${sourceStats.dev}:${targetStats.dev}`
}

/** Whether copying `source` into `targetDirectory` would share blocks instead
 *  of duplicating them. The probe reflinks one real file into
 *  `targetDirectory` under a temporary name and removes it — nothing else is
 *  written — and the verdict is cached per filesystem pair for the rest of the
 *  materialization. A failed probe answers "no", matching the clone's own
 *  refusal, so a caller can size the work before any bytes land. */
export async function canCloneWithReflink(
  source: string,
  targetDirectory: string,
  deps: ReflinkCloneDeps = defaultReflinkCloneDeps,
  filesystemCache: ReflinkFilesystemCache = new Map()
): Promise<boolean> {
  try {
    const key = await filesystemPairKey(source, targetDirectory)
    const cached = filesystemCache.get(key)
    if (cached) {
      return await cached
    }
    const probeSource = await findProbeFile(source)
    // Why: leave the pair unprobed rather than cache "no" from a source that
    // had nothing to learn from; a later, fuller source may still answer.
    if (!probeSource) {
      return false
    }
    const pending = probeReflink(probeSource, targetDirectory, deps)
    filesystemCache.set(key, pending)
    return await pending
  } catch {
    return false
  }
}

async function cloneFileWithReflink(
  source: string,
  target: string,
  deps: ReflinkCloneDeps
): Promise<void> {
  const staging = await mkdtemp(join(dirname(target), '.orca-reflink-clone-'))
  const tempTarget = join(staging, 'file')
  try {
    await deps.reflinkFile(source, tempTarget)
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
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function cloneDirectoryWithReflink(
  source: string,
  target: string,
  deps: ReflinkCloneDeps
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

  let staging: string | undefined
  let cleanupAllowed = true
  let publicationStarted = false
  try {
    staging = await mkdtemp(join(dirname(target), '.orca-reflink-stage-'))
    const stagedTree = join(staging, 'tree')
    await mkdir(stagedTree)
    // Failed strict clones can leave empty files; never publish those into the fallback target.
    await deps.reflinkTree(source, stagedTree)
    publicationStarted = true
    await deps.publishTree(stagedTree, target)
    await chmod(target, sourceMode)
  } catch (error) {
    cleanupAllowed = !(
      error instanceof WorktreeCloneInterruptedError && error.termination === 'unverifiable'
    )
    // Why: remove only the empty reservation. If anything was cloned, or
    // another process raced files into the directory, leave it for Git/user
    // review.
    if (cleanupAllowed) {
      await rmdir(target).catch(() => undefined)
    }
    if (publicationStarted && !(error instanceof WorktreeCloneInterruptedError)) {
      throw new WorktreeClonePartialError(target, error)
    }
    throw error
  } finally {
    if (staging && cleanupAllowed) {
      await removeWorktreeCloneStaging(staging)
    }
  }
}

/** Linux counterpart of the APFS clone-copy: `ioctl(FICLONE)` shares data
 *  blocks between two files on one filesystem (btrfs, XFS with reflink,
 *  OpenZFS 2.2+ with block cloning), so a worktree gets a private copy that
 *  costs metadata rather than bytes. Needs no privilege and no filesystem
 *  layout — which is why it is used instead of a dataset- or subvolume-level
 *  snapshot/clone that would want root, delegation, and its own lifecycle. */
export async function cloneWorktreePathWithReflink(
  source: string,
  target: string,
  sourceIsDirectory: boolean,
  deps: ReflinkCloneDeps = defaultReflinkCloneDeps,
  filesystemCache: ReflinkFilesystemCache = new Map()
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  if (!(await canCloneWithReflink(source, dirname(target), deps, filesystemCache))) {
    throw new WorktreeCloneUnavailableError(
      'reflink clone-copy requires source and target on one filesystem that supports FICLONE'
    )
  }
  await (sourceIsDirectory
    ? cloneDirectoryWithReflink(source, target, deps)
    : cloneFileWithReflink(source, target, deps))
}
