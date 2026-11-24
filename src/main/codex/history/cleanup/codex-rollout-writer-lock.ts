import { lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/**
 * Codex holds `thread-writer-locks/<thread id>.lock` while a process has the thread open, also
 * after a resume that hasn't written a turn yet; deleting then would cut off every later turn.
 * Codex versions that keep no locks give no such proof, so their rollouts are kept.
 */
export async function isOpenInCodex(homes: readonly string[], stem: string): Promise<boolean> {
  // A reverted thread's name carries its thread id and its rollout id: either can be the lock's.
  const ids = basename(stem).toLowerCase().match(UUID_PATTERN) ?? []
  if (ids.length === 0) {
    return true
  }
  let keepsLocks = false
  for (const home of homes) {
    const locks = join(home, 'thread-writer-locks')
    for (const id of ids) {
      try {
        await lstat(join(locks, `${id}.lock`))
        return true
      } catch (error) {
        if (!isDefinitiveAbsence(error)) {
          return true
        }
      }
    }
    keepsLocks ||= await lstat(locks).then(
      (entry) => entry.isDirectory(),
      () => false
    )
  }
  return !keepsLocks
}

/** Positive proof that some home currently holds this thread's writer lock. */
export async function hasCodexWriterLock(homes: readonly string[], stem: string): Promise<boolean> {
  const ids = basename(stem).toLowerCase().match(UUID_PATTERN) ?? []
  for (const home of homes) {
    for (const id of ids) {
      try {
        await lstat(join(home, 'thread-writer-locks', `${id}.lock`))
        return true
      } catch (error) {
        if (!isDefinitiveAbsence(error)) {
          return false
        }
      }
    }
  }
  return false
}
