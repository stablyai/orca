import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import { APPIMAGE_EXTRACTION_TIMEOUT_MS } from './appimage-extraction-pruning'

const LOCK_TARGET_NAME = '.cli-registration'
const LOCK_STALE_MS = APPIMAGE_EXTRACTION_TIMEOUT_MS * 3
// Why a wall-clock deadline: `retries` alone bounds the attempt count, not the wait — 1000 attempts
// at up to 1s each let an IPC-driven registration hang ~16 minutes against a wedged holder with no
// feedback. A legitimate holder is bounded by the extraction timeout, so anything past that plus
// slack is wedged, and failing with a message beats hanging.
const LOCK_ACQUIRE_DEADLINE_MS = APPIMAGE_EXTRACTION_TIMEOUT_MS + 30_000
const LOCK_RETRIES = {
  retries: 1_000,
  factor: 1.2,
  minTimeout: 25,
  maxTimeout: 1_000,
  randomize: true,
  maxRetryTime: LOCK_ACQUIRE_DEADLINE_MS
}

export async function withAppImageRegistrationLock<T>(
  cacheRootPath: string,
  operation: () => Promise<T>
): Promise<T> {
  await mkdir(cacheRootPath, { recursive: true, mode: 0o700 })
  let release: () => Promise<void>
  try {
    release = await lock(join(cacheRootPath, LOCK_TARGET_NAME), {
      realpath: false,
      retries: LOCK_RETRIES,
      stale: LOCK_STALE_MS,
      update: APPIMAGE_EXTRACTION_TIMEOUT_MS / 10
    })
  } catch (error) {
    throw new Error(
      `Timed out waiting for another Orca process to finish CLI registration ` +
        `(waited ${Math.round(LOCK_ACQUIRE_DEADLINE_MS / 1000)}s). ` +
        `If no other Orca is running, remove ${join(cacheRootPath, LOCK_TARGET_NAME)}.lock and retry.`,
      { cause: error }
    )
  }
  try {
    return await operation()
  } finally {
    await release()
  }
}
