import type { Dirent } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalDownloadedFolderPromotionBudget } from './local-downloaded-folder-promotion-budget'

export async function readPromotionDirectoryEntries(
  sourcePath: string,
  destinationPath: string,
  budget: LocalDownloadedFolderPromotionBudget,
  depth: number
): Promise<Dirent[]> {
  const entries: Dirent[] = []
  const directory = await opendir(sourcePath)
  try {
    for await (const entry of directory) {
      budget.recordEntry(join(sourcePath, entry.name), join(destinationPath, entry.name), depth + 1)
      entries.push(entry)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

export async function assertPromotionTreeWithinCapacity(
  sourceRoot: string,
  destinationRoot: string,
  signal?: AbortSignal
): Promise<void> {
  const budget = new LocalDownloadedFolderPromotionBudget()
  const pending = [{ sourcePath: sourceRoot, destinationPath: destinationRoot, depth: 0 }]
  while (pending.length > 0) {
    signal?.throwIfAborted()
    const current = pending.pop()!
    const directory = await opendir(current.sourcePath)
    try {
      for await (const entry of directory) {
        signal?.throwIfAborted()
        const sourcePath = join(current.sourcePath, entry.name)
        const destinationPath = join(current.destinationPath, entry.name)
        const depth = current.depth + 1
        budget.recordEntry(sourcePath, destinationPath, depth)
        if (entry.isDirectory()) {
          pending.push({ sourcePath, destinationPath, depth })
        }
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
  }
}
