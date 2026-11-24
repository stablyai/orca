import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import { APPIMAGE_EXTRACTION_TIMEOUT_MS } from './appimage-extraction-pruning'

const LOCK_TARGET_NAME = '.cli-registration'
const LOCK_STALE_MS = APPIMAGE_EXTRACTION_TIMEOUT_MS * 3
// Retry count alone can stall registration for minutes; bound elapsed time to extraction plus slack.
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
  operation: () => Promise<T>,
  options: { deadlineAt?: number } = {}
): Promise<T> {
  await mkdir(cacheRootPath, { recursive: true, mode: 0o700 })
  const waitMs = Math.min(
    LOCK_ACQUIRE_DEADLINE_MS,
    options.deadlineAt === undefined ? Infinity : options.deadlineAt - Date.now()
  )
  let release: () => Promise<void>
  try {
    if (waitMs <= 0) {
      throw new Error('deadline already passed')
    }
    release = await lock(join(cacheRootPath, LOCK_TARGET_NAME), {
      realpath: false,
      retries: { ...LOCK_RETRIES, maxRetryTime: waitMs },
      stale: LOCK_STALE_MS,
      update: APPIMAGE_EXTRACTION_TIMEOUT_MS / 10
    })
  } catch (error) {
    throw new Error(
      `Timed out waiting for another Orca process to finish CLI registration ` +
        `(waited ${Math.round(Math.max(waitMs, 0) / 1000)}s). ` +
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
