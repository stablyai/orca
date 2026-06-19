import { readdirSync } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { join } from 'node:path'

export type CodexSessionBridgeIncrementalOptions = {
  batchSize?: number
  yieldMs?: number
}

const INCREMENTAL_BRIDGE_BATCH_SIZE = 64
const INCREMENTAL_BRIDGE_YIELD_MS = 10

export function listCodexSessionJsonlFiles(rootPath: string): string[] {
  const files: string[] = []
  try {
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      const childPath = join(rootPath, entry.name)
      if (entry.isDirectory()) {
        appendSessionFilePaths(files, listCodexSessionJsonlFiles(childPath))
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(childPath)
      }
    }
  } catch (error) {
    console.warn('[codex-session-bridge] Failed to list system Codex sessions:', error)
  }
  return files.sort()
}

function appendSessionFilePaths(target: string[], source: readonly string[]): void {
  // Why: existing Codex homes can accumulate enough nested sessions to exceed
  // V8's argument limit if child arrays are spread into push().
  for (const filePath of source) {
    target.push(filePath)
  }
}

export async function* listCodexSessionJsonlFilesIncrementally(
  rootPath: string,
  options: CodexSessionBridgeIncrementalOptions
): AsyncGenerator<string> {
  const batchSize = Math.max(1, options.batchSize ?? INCREMENTAL_BRIDGE_BATCH_SIZE)
  const yieldMs = Math.max(0, options.yieldMs ?? INCREMENTAL_BRIDGE_YIELD_MS)
  const pendingDirectories = [rootPath]
  let entriesSinceYield = 0

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop()
    if (!currentDirectory) {
      continue
    }
    try {
      const directory = await opendir(currentDirectory)
      for await (const entry of directory) {
        const childPath = join(currentDirectory, entry.name)
        if (entry.isDirectory()) {
          pendingDirectories.push(childPath)
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          yield childPath
        }
        entriesSinceYield += 1
        if (entriesSinceYield >= batchSize) {
          entriesSinceYield = 0
          await delayIncrementalBridge(yieldMs)
        }
      }
    } catch (error) {
      console.warn('[codex-session-bridge] Failed to list system Codex sessions:', error)
    }
  }
}

function delayIncrementalBridge(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
