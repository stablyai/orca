import { constants, type BigIntStats } from 'node:fs'
import { copyFile, rm, stat, utimes } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runProcess } from '@orca/process-host'

// Below this a cp spawn costs more than the copy it saves.
const MIN_DARWIN_CLONE_BYTES = 1024 * 1024

/** Reading the source failed (unreadable, offline placeholder, gone): that file only, not the store. */
export class RolloutSourceReadError extends Error {
  constructor(sourcePath: string, cause: unknown) {
    super(`Cannot read rollout ${sourcePath}`, { cause })
    this.name = 'RolloutSourceReadError'
  }
}

export async function readingSource<T>(sourcePath: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    throw new RolloutSourceReadError(sourcePath, error)
  }
}

/** Clears the Finder lock and append-only flags a macOS clone carries over from its source. */
export async function clearDarwinFileFlags(path: string): Promise<boolean> {
  try {
    const result = await runProcess({
      program: '/usr/bin/chflags',
      args: ['nouchg,nouappnd', path],
      maxOutputBytes: 8192
    })
    return result.code === 0
  } catch {
    return false
  }
}

/** Removes a staged copy, clearing flags a macOS clone carried over once a removal is refused. */
export async function removeStagedCopy(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch (error) {
    // EPERM under Node; other runtimes report a locked file differently, so any failure retries once.
    if (process.platform !== 'darwin' || !(await clearDarwinFileFlags(path))) {
      throw error
    }
    await rm(path, { force: true })
  }
}

async function cloneOnDarwin(sourcePath: string, temporaryPath: string): Promise<boolean> {
  try {
    // Node's clone flag never clones on macOS; cp -c does. -p keeps the times.
    const result = await runProcess({
      program: '/bin/cp',
      args: ['-c', '-p', sourcePath, temporaryPath],
      timeoutMs: null,
      maxOutputBytes: 8192
    })
    if (result.code === 0) {
      return true
    }
  } catch {
    // Falls through to an ordinary copy.
  }
  await removeStagedCopy(temporaryPath)
  return false
}

/**
 * Stages `source` at `temporaryPath` with the source's times: a macOS clone on the same volume,
 * otherwise a copy that reflinks (Linux) or block-clones (Windows ReFS, Dev Drive) where it can.
 */
export async function stageRolloutCopy(
  source: BigIntStats,
  sourcePath: string,
  temporaryPath: string
): Promise<void> {
  if (
    process.platform === 'darwin' &&
    source.size >= MIN_DARWIN_CLONE_BYTES &&
    (await stat(dirname(temporaryPath), { bigint: true })).dev === source.dev &&
    (await cloneOnDarwin(sourcePath, temporaryPath))
  ) {
    return
  }
  await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  // Compressed-twin rules and recency read the rollout's mtime.
  await utimes(temporaryPath, Number(source.atimeNs) / 1e9, Number(source.mtimeNs) / 1e9)
}
