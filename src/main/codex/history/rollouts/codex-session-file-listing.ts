import { opendir } from 'node:fs/promises'
import { join } from 'node:path'

export type CodexSessionBridgeIncrementalOptions = {
  /** Include symlink leaves so deletion can reject unsupported aliases. */
  includeSymlinkFiles?: boolean
  /** Directory entries to process before yielding back to the event loop. */
  batchSize?: number
  /** Delay after each processed batch; zero still yields on a timer turn. */
  yieldMs?: number
}

const INCREMENTAL_BRIDGE_BATCH_SIZE = 64
const INCREMENTAL_BRIDGE_YIELD_MS = 10

export async function* listCodexSessionJsonlFilesIncrementally(
  rootPath: string,
  options: CodexSessionBridgeIncrementalOptions,
  onDirectoryError?: (directoryPath: string, error: unknown) => void | Promise<void>
): AsyncGenerator<string> {
  yield* listCodexSessionFilesIncrementally(
    rootPath,
    options,
    (fileName) => fileName.endsWith('.jsonl'),
    onDirectoryError
  )
}

export function isCodexSessionRolloutFileName(fileName: string): boolean {
  return fileName.endsWith('.jsonl') || fileName.endsWith('.jsonl.zst')
}

export async function* listCodexSessionRolloutFilesIncrementally(
  rootPath: string,
  options: CodexSessionBridgeIncrementalOptions,
  onDirectoryError?: (directoryPath: string, error: unknown) => void | Promise<void>
): AsyncGenerator<string> {
  yield* listCodexSessionFilesIncrementally(
    rootPath,
    options,
    isCodexSessionRolloutFileName,
    onDirectoryError
  )
}

async function* listCodexSessionFilesIncrementally(
  rootPath: string,
  options: CodexSessionBridgeIncrementalOptions,
  isSessionFile: (fileName: string) => boolean,
  onDirectoryError?: (directoryPath: string, error: unknown) => void | Promise<void>
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
        } else if (
          (entry.isFile() || (options.includeSymlinkFiles && entry.isSymbolicLink())) &&
          isSessionFile(entry.name)
        ) {
          yield childPath
        }
        entriesSinceYield += 1
        if (entriesSinceYield >= batchSize) {
          entriesSinceYield = 0
          await delayIncrementalBridge(yieldMs)
        }
      }
    } catch (error) {
      await onDirectoryError?.(currentDirectory, error)
      console.warn('[codex-session-bridge] Failed to list system Codex sessions:', error)
    }
  }
}

function delayIncrementalBridge(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
