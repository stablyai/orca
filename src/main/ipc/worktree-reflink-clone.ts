import { randomUUID } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { chmod, copyFile, link, mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import {
  isAlreadyExistsError,
  WorktreeCloneUnavailableError,
  WorktreeLinkedPathTargetExistsError
} from './worktree-clone-copy-errors'

export type ReflinkCloneDeps = {
  /** The probe: `FICLONE` or nothing. Must throw rather than copy bytes when
   *  the filesystem cannot share blocks. */
  reflinkFileOrFail: (source: string, target: string) => Promise<void>
  /** `FICLONE` per file, a byte copy for any file the kernel declines. */
  reflinkFile: (source: string, target: string) => Promise<void>
  /** Recursive reflink of a directory's contents into an existing `target`
   *  that skips (never clobbers) whatever is already there. */
  reflinkTree: (source: string, target: string) => Promise<void>
  randomUUID: () => string
}

// Why the clone itself is not forced: OpenZFS refuses to clone a block written
// in the still-open transaction group (EAGAIN unless zfs_bclone_wait_dirty), so
// a file touched seconds ago would fail a forced tree clone outright. Unforced,
// that one file is copied byte-for-byte and everything else shares blocks.
//
// Why the tree goes through coreutils rather than `fs.cp`: Node pays several
// syscall round trips per file whether or not the kernel shares blocks, which
// on a 20k-file node_modules is ~6 s — the same as a byte copy — while `cp`
// walks the tree in ~0.5 s. Same shape as the APFS backend's `/bin/cp -c`.
export const defaultReflinkCloneDeps: ReflinkCloneDeps = {
  reflinkFileOrFail: (source, target) => copyFile(source, target, constants.COPYFILE_FICLONE_FORCE),
  reflinkFile: (source, target) => copyFile(source, target, constants.COPYFILE_FICLONE),
  reflinkTree: async (source, target) => {
    // Why `-n`: the target directory is reserved before this runs, so a raced
    // nested file must be kept, not overwritten. `--update=none` is the modern
    // spelling but coreutils 8.x (Ubuntu 20.04) only knows `-n`.
    // Why `source/.`: contents land at the requested path even when the source
    // is a symlinked directory.
    const result = await runProcess({
      program: '/bin/cp',
      args: ['-n', '-R', '--reflink=auto', `${source}${sep}.`, target],
      timeoutMs: null
    })
    if (result.code !== 0) {
      throw new Error(
        `cp --reflink exited ${result.code ?? result.signal ?? 'unknown'}: ${result.stderr.trim()}`
      )
    }
  },
  randomUUID
}

/** Per-materialization cache keyed by the source and target `stat().dev` pair.
 *  Reflink support is a property of the filesystem, so one probe answers for
 *  every path that lands on the same pair. */
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
  const probeTarget = resolve(targetDirectory, `.orca-reflink-probe-${deps.randomUUID()}`)
  try {
    await deps.reflinkFileOrFail(probeSource, probeTarget)
    return true
  } catch (error) {
    // Why: EAGAIN is OpenZFS declining a block still in the open transaction
    // group — the filesystem understood the request. A filesystem without the
    // feature answers ENOTSUP, a pool with block cloning off ENOTTY, a
    // different filesystem EXDEV.
    return (error as { code?: unknown })?.code === 'EAGAIN'
  } finally {
    await rm(probeTarget, { force: true }).catch(() => undefined)
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
  const tempTarget = resolve(dirname(target), `.orca-reflink-clone-${deps.randomUUID()}`)
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
    await rm(tempTarget, { force: true }).catch(() => undefined)
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

  try {
    // Why: the tree clone merges into the reserved directory and skips anything
    // raced into it; the reservation was created with the default mode, so the
    // source mode is applied afterwards.
    await deps.reflinkTree(source, target)
    await chmod(target, sourceMode)
  } catch (error) {
    // Why: remove only the empty reservation. If anything was cloned, or
    // another process raced files into the directory, leave it for Git/user
    // review.
    await rmdir(target).catch(() => undefined)
    throw error
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
