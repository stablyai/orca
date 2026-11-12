import { execFile, type ExecFileOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, stat, rm, link, rmdir, chmod } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options?: Pick<ExecFileOptions, 'timeout'>
) => Promise<{ stdout: string; stderr: string }>

const execFileAsync = promisify(execFile) as ExecFileAsync
// Bound volume probes so hung mounts cannot stall worktree creation.
const APFS_FILESYSTEM_PROBE_TIMEOUT_MS = 5_000

export type ApfsCloneDeps = {
  execFileAsync: ExecFileAsync
  randomUUID: () => string
}

export const defaultApfsCloneDeps: ApfsCloneDeps = {
  execFileAsync,
  randomUUID
}

type DarwinFilesystemInfo = {
  device: string
  filesystemName: string
}

/** Share volume probes by device within one materialization instead of spawning df/diskutil per copied path. */
export type DarwinFilesystemCache = Map<number, Promise<DarwinFilesystemInfo>>

export class ApfsCloneUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApfsCloneUnavailableError'
  }
}

export class WorktreeLinkedPathTargetExistsError extends Error {
  constructor(target: string) {
    super(`Worktree linked path target already exists: ${target}`)
    this.name = 'WorktreeLinkedPathTargetExistsError'
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'EEXIST'
}

async function getDarwinFilesystemInfo(
  path: string,
  deps: ApfsCloneDeps
): Promise<DarwinFilesystemInfo> {
  const { stdout: dfOutput } = await deps.execFileAsync('/bin/df', ['-P', path], {
    timeout: APFS_FILESYSTEM_PROBE_TIMEOUT_MS
  })
  const device = dfOutput.trim().split(/\r?\n/)[1]?.trim().split(/\s+/)[0]
  if (!device) {
    throw new Error(`Could not resolve filesystem device for ${path}`)
  }
  const { stdout: diskutilOutput } = await deps.execFileAsync(
    '/usr/sbin/diskutil',
    ['info', '-plist', device],
    { timeout: APFS_FILESYSTEM_PROBE_TIMEOUT_MS }
  )
  const filesystemNameMatch = /<key>FilesystemName<\/key>\s*<string>([^<]+)<\/string>/u.exec(
    diskutilOutput
  )
  return {
    device,
    filesystemName: filesystemNameMatch?.[1] ?? ''
  }
}

async function getCachedDarwinFilesystemInfo(
  path: string,
  deps: ApfsCloneDeps,
  cache: DarwinFilesystemCache
): Promise<DarwinFilesystemInfo> {
  const deviceId = (await stat(path)).dev
  const cached = cache.get(deviceId)
  if (cached) {
    return cached
  }
  // Cache pending and rejected probes so every path on a volume shares the same process pair.
  const pending = getDarwinFilesystemInfo(path, deps)
  cache.set(deviceId, pending)
  return pending
}

async function isSameApfsVolume(
  source: string,
  targetDirectory: string,
  deps: ApfsCloneDeps,
  cache: DarwinFilesystemCache
): Promise<boolean> {
  const [sourceInfo, targetInfo] = await Promise.all([
    getCachedDarwinFilesystemInfo(source, deps, cache),
    getCachedDarwinFilesystemInfo(targetDirectory, deps, cache)
  ])
  return (
    sourceInfo.device === targetInfo.device &&
    sourceInfo.filesystemName === 'APFS' &&
    targetInfo.filesystemName === 'APFS'
  )
}

async function assertSameApfsVolume(
  source: string,
  target: string,
  deps: ApfsCloneDeps,
  cache: DarwinFilesystemCache
): Promise<void> {
  if (!(await isSameApfsVolume(source, dirname(target), deps, cache))) {
    throw new ApfsCloneUnavailableError(
      'APFS clone-copy requires source and target on the same APFS volume'
    )
  }
}

/** Probe without writing, sharing clone volume detection; failure selects the ordinary-copy fallback. */
export async function canCloneWithApfs(
  source: string,
  targetDirectory: string,
  deps: ApfsCloneDeps = defaultApfsCloneDeps,
  filesystemCache: DarwinFilesystemCache = new Map()
): Promise<boolean> {
  try {
    return await isSameApfsVolume(source, targetDirectory, deps, filesystemCache)
  } catch {
    return false
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
      // link atomically refuses an existing target; rename could clobber one created after preflight.
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
    // Reserve the final directory before copying so a raced user directory cannot be replaced.
    await mkdir(target)
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new WorktreeLinkedPathTargetExistsError(target)
    }
    throw error
  }

  try {
    // Copy source/. into the reserved target; -n protects raced nested files, including symlinked source directories.
    await deps.execFileAsync('/bin/cp', ['-n', '-c', '-R', `${source}${sep}.`, target])
    await chmod(target, sourceMode)
  } catch (error) {
    // Remove only an empty reservation; preserve copied or raced contents for review.
    await rmdir(target).catch(() => undefined)
    throw error
  }
}

export async function cloneWorktreePathWithApfs(
  source: string,
  target: string,
  sourceIsDirectory: boolean,
  deps: ApfsCloneDeps = defaultApfsCloneDeps,
  filesystemCache: DarwinFilesystemCache = new Map()
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  await assertSameApfsVolume(source, target, deps, filesystemCache)
  // Node clone-force returns ENOSYS here; preflight APFS before cp -c to avoid a surprise full copy.
  await (sourceIsDirectory
    ? cloneDirectoryWithApfs(source, target, deps)
    : cloneFileWithApfs(source, target, deps))
}
