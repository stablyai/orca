import { lock } from 'proper-lockfile'
import { runKeyedSerializedOperation } from '../../../shared/concurrency/keyed-serialized-operations'

// Defer held locks to Claude; keep the long stale window's refresh timer within setTimeout range.
const NEVER_STALE_MS = 2 ** 30
const LOCK_RETRIES = { retries: 4, factor: 2, minTimeout: 50, maxTimeout: 250 }
// Serialize local updates to avoid exhausting file-lock retries during launch bursts.
const updateQueueByConfigFile = new Map<string, Promise<void>>()

/** Orca's own writers of one Claude config file, one at a time. */
export function runSerializedForClaudeConfig<T>(
  configFile: string,
  run: () => Promise<T>
): Promise<T> {
  return runKeyedSerializedOperation(updateQueueByConfigFile, configFile, run)
}

/** The lock Claude Code itself takes on its config. */
export function lockClaudeConfig(configFile: string): Promise<() => Promise<void>> {
  return lock(configFile, {
    // Claude locks the literal path, even for symlinked configs.
    lockfilePath: `${configFile}.lock`,
    realpath: false,
    stale: NEVER_STALE_MS,
    retries: LOCK_RETRIES,
    onCompromised: () => {}
  })
}

/**
 * Runs `edit` (read through publish) under Claude's lock and Orca's queue for the file, for writers
 * that splice the text instead of rewriting the whole object.
 */
export function withClaudeGlobalConfigLock<T>(
  configFile: string,
  edit: () => Promise<T>
): Promise<T | 'locked'> {
  return runSerializedForClaudeConfig(configFile, async () => {
    let release: () => Promise<void>
    try {
      release = await lockClaudeConfig(configFile)
    } catch {
      return 'locked' as const
    }
    try {
      return await edit()
    } finally {
      await release().catch(() => {})
    }
  })
}
