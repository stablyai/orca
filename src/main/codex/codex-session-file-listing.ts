import { readdirSync } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'

const TRUSTED_CODEX_ROLLOUT_TAIL = String.raw`\d{4}/\d{2}/\d{2}/rollout-[^/:]+\.jsonl(?:\.zst)?`
const ROLLOUT_RELATIVE_PATH = new RegExp(`^${TRUSTED_CODEX_ROLLOUT_TAIL}$`)

// Only fold extended drive paths; reject device namespaces and extended UNC paths.
function toCodexTrustedPathComparisonCopy(filePath: string): string | null {
  if (filePath.startsWith('\\\\.\\')) {
    return null
  }
  if (!filePath.startsWith('\\\\?\\')) {
    return filePath
  }
  return filePath.match(/^\\\\\?\\([A-Za-z]:[\\/][\s\S]*)$/)?.[1] ?? null
}

/** Returns the `YYYY/MM/DD/rollout-*.jsonl` tail, or null outside the dated layout. */
export function codexDatedRolloutRelativePath(
  sessionsRoot: string,
  filePath: string
): string | null {
  const comparisonSessionsRoot = toCodexTrustedPathComparisonCopy(sessionsRoot)
  const comparisonFilePath = toCodexTrustedPathComparisonCopy(filePath)
  if (!comparisonSessionsRoot || !comparisonFilePath) {
    return null
  }
  // Windows-syntax suffixes come back with `/` separators; POSIX keeps `\` as a name byte.
  const relativePath = relativePathInsideRoot(comparisonSessionsRoot, comparisonFilePath)
  return relativePath && ROLLOUT_RELATIVE_PATH.test(relativePath) ? relativePath : null
}

export type CodexSessionBridgeIncrementalOptions = {
  /** Directory entries to process before yielding back to the event loop. */
  batchSize?: number
  /** Delay after each processed batch; zero still yields on a timer turn. */
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
  // Large histories can exceed V8's argument limit if spread into push().
  for (const filePath of source) {
    target.push(filePath)
  }
}

/** Yield between batches so large histories cannot monopolize startup. */
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

export async function* listCodexSessionRolloutFilesIncrementally(
  rootPath: string,
  options: CodexSessionBridgeIncrementalOptions,
  onDirectoryError?: (directoryPath: string, error: unknown) => void | Promise<void>
): AsyncGenerator<string> {
  yield* listCodexSessionFilesIncrementally(
    rootPath,
    options,
    (fileName) => fileName.endsWith('.jsonl') || fileName.endsWith('.jsonl.zst'),
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
        } else if (entry.isFile() && isSessionFile(entry.name)) {
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
