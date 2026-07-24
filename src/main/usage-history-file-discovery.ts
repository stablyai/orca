import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import type { UsageHistoryScanBudget } from './usage-history-scan-budget'

export async function walkUsageHistoryJsonlFiles(
  rootPath: string,
  budget: UsageHistoryScanBudget
): Promise<string[]> {
  const pendingDirectories = [rootPath]
  const files: string[] = []

  while (pendingDirectories.length > 0) {
    const directoryPath = pendingDirectories.pop()!
    let directory: Awaited<ReturnType<typeof opendir>>
    try {
      directory = await opendir(directoryPath)
    } catch (error) {
      if (directoryPath !== rootPath && isVanishedDirectoryError(error)) {
        continue
      }
      throw error
    }
    for await (const entry of directory) {
      budget.claimDiscoveryEntry()
      const fullPath = join(directoryPath, entry.name)
      if (entry.isDirectory()) {
        budget.claimPath(fullPath)
        pendingDirectories.push(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        budget.claimFile(fullPath)
        files.push(fullPath)
      }
    }
  }

  return files
}

function isVanishedDirectoryError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false
  }
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}
