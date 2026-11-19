import { constants, type BigIntStats } from 'node:fs'
import { copyFile, open, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runProcess } from '@orca/process-host'

// Below this a cp spawn costs more than the copy it saves.
const MIN_DARWIN_CLONE_BYTES = 1024 * 1024
const COPY_CHUNK_BYTES = 1024 * 1024
const STOP_POLL_MS = 50

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

export async function clearDarwinLockFlag(path: string): Promise<boolean> {
  try {
    const result = await runProcess({
      program: '/usr/bin/chflags',
      args: ['nouchg', path],
      maxOutputBytes: 8192
    })
    return result.code === 0
  } catch {
    return false
  }
}

/** Removes a staged copy, clearing a Finder lock a macOS clone carried over from its source. */
export async function removeStagedCopy(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch (error) {
    // EPERM under Node; other runtimes report a locked file differently, so any failure retries once.
    if (process.platform !== 'darwin' || !(await clearDarwinLockFlag(path))) {
      throw error
    }
    await rm(path, { force: true })
  }
}

function abortWhen(shouldStop: () => boolean): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const check = (): void => {
    if (shouldStop()) {
      controller.abort()
    } else {
      timer = setTimeout(check, STOP_POLL_MS)
    }
  }
  timer = setTimeout(check, STOP_POLL_MS)
  return { signal: controller.signal, dispose: () => clearTimeout(timer) }
}

async function cloneOnDarwin(
  sourcePath: string,
  temporaryPath: string,
  shouldStop: () => boolean
): Promise<'cloned' | 'failed' | 'stopped'> {
  const stop = abortWhen(shouldStop)
  try {
    // Node's clone flag never clones on macOS; cp -c does. -p keeps the times.
    const result = await runProcess({
      program: '/bin/cp',
      args: ['-c', '-p', sourcePath, temporaryPath],
      timeoutMs: null,
      maxOutputBytes: 8192,
      signal: stop.signal
    })
    if (stop.signal.aborted) {
      return 'stopped'
    }
    if (result.code === 0) {
      return 'cloned'
    }
  } catch {
    // Falls through to a chunked copy.
  } finally {
    stop.dispose()
  }
  await removeStagedCopy(temporaryPath)
  return 'failed'
}

async function cloneOnLinux(sourcePath: string, temporaryPath: string): Promise<boolean> {
  try {
    // A reflink, or an immediate error where the filesystem has none.
    await copyFile(
      sourcePath,
      temporaryPath,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE
    )
    return true
  } catch {
    await removeStagedCopy(temporaryPath)
    return false
  }
}

async function copyInChunks(
  sourcePath: string,
  temporaryPath: string,
  mode: number,
  shouldStop: () => boolean
): Promise<'copied' | 'stopped'> {
  const source = await readingSource(sourcePath, () => open(sourcePath, 'r'))
  try {
    const target = await open(temporaryPath, 'wx', mode)
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
      while (!shouldStop()) {
        const { bytesRead } = await readingSource(sourcePath, () =>
          source.read(buffer, 0, COPY_CHUNK_BYTES, null)
        )
        if (bytesRead === 0) {
          return 'copied'
        }
        let written = 0
        while (written < bytesRead) {
          written += (await target.write(buffer, written, bytesRead - written)).bytesWritten
        }
      }
      return 'stopped'
    } finally {
      await target.close()
    }
  } finally {
    await source.close()
  }
}

/**
 * Stages `source` at `temporaryPath`: a clone where one is quick and certain (macOS on the same
 * volume, a Linux reflink), otherwise a chunked copy that `shouldStop` interrupts between chunks.
 * `cloned` keeps the source's times; a copy still needs them set.
 */
export async function stageRolloutCopy(
  source: BigIntStats,
  sourcePath: string,
  temporaryPath: string,
  shouldStop: () => boolean
): Promise<'cloned' | 'copied' | 'stopped'> {
  if (
    process.platform === 'darwin' &&
    source.size >= MIN_DARWIN_CLONE_BYTES &&
    (await stat(dirname(temporaryPath), { bigint: true })).dev === source.dev
  ) {
    const cloned = await cloneOnDarwin(sourcePath, temporaryPath, shouldStop)
    if (cloned !== 'failed') {
      return cloned
    }
  }
  if (process.platform === 'linux' && (await cloneOnLinux(sourcePath, temporaryPath))) {
    return 'copied'
  }
  return copyInChunks(sourcePath, temporaryPath, Number(source.mode & 0o777n), shouldStop)
}
