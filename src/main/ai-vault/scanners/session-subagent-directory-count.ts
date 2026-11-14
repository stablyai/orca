import type { Dirent } from 'node:fs'
import {
  wslGatedReaddir,
  wslGatedStat
} from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../scan-lifecycle/ai-vault-scan-cancellation'

type Count = { version: string; count: number }
const counts = new Map<string, Count>()

/** Validate the counted directory itself, including absence, so late task files remain discoverable. */
export async function countSessionSubagentDirectory(
  path: string,
  accepts: (entry: Dirent) => boolean,
  signal?: AbortSignal
): Promise<number> {
  try {
    const stats = await waitForAiVaultScan(wslGatedStat(path, 'scan', signal), signal)
    const version = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}:${stats.mtimeMs}:${stats.ctimeMs}`
    const previous = counts.get(path)
    if (previous?.version === version) {
      return previous.count
    }
    const entries = await waitForAiVaultScan(wslGatedReaddir(path, 'scan', signal), signal)
    throwIfAiVaultScanCancelled(signal)
    const count = entries.filter(accepts).length
    counts.delete(path)
    counts.set(path, { version, count })
    if (counts.size > 4096) {
      const oldest = counts.keys().next().value
      if (oldest !== undefined) {
        counts.delete(oldest)
      }
    }
    return count
  } catch {
    throwIfAiVaultScanCancelled(signal)
    counts.delete(path)
    return 0
  }
}
