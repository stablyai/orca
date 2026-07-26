import { opendirSync } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CodexSessionListingBudget,
  CodexSessionListingCapacityError,
  type CodexSessionListingLimits
} from './codex-session-listing-budget'

export {
  CODEX_SESSION_LISTING_MAX_DEPTH,
  CODEX_SESSION_LISTING_MAX_ENTRIES,
  CODEX_SESSION_LISTING_MAX_FILES,
  CODEX_SESSION_LISTING_MAX_PATH_CODE_UNITS,
  CodexSessionListingCapacityError
} from './codex-session-listing-budget'

export type CodexSessionBridgeIncrementalOptions = {
  /** Directory entries to process before yielding back to the event loop. */
  batchSize?: number
  /** Optional lower limits for tests or constrained callers. */
  limits?: Partial<CodexSessionListingLimits>
  /** Delay after each processed batch; zero still yields on a timer turn. */
  yieldMs?: number
}

const INCREMENTAL_BRIDGE_BATCH_SIZE = 64
const INCREMENTAL_BRIDGE_YIELD_MS = 10

/**
 * Recursively lists session JSONL files below a root directory.
 *
 * This synchronous variant preserves the historical bridge behavior for callers
 * that run outside the CLI launch path.
 */
export function listCodexSessionJsonlFiles(rootPath: string): string[] {
  return listCodexSessionJsonlFilesWithinLimits(rootPath)
}

export function listCodexSessionJsonlFilesWithinLimits(
  rootPath: string,
  limits: Partial<CodexSessionListingLimits> = {}
): string[] {
  const budget = new CodexSessionListingBudget(limits)
  budget.claimDepth(0)
  budget.claimPath(rootPath)
  const files: string[] = []
  const pendingDirectories = [{ depth: 0, path: rootPath }]

  while (pendingDirectories.length > 0) {
    const current = pendingDirectories.pop()!
    let directory: ReturnType<typeof opendirSync>
    try {
      directory = opendirSync(current.path)
    } catch (error) {
      warnAboutCodexSessionListingError(error)
      continue
    }
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        budget.claimEntry()
        const childPath = join(current.path, entry.name)
        budget.claimPath(childPath)
        if (entry.isDirectory()) {
          const depth = current.depth + 1
          budget.claimDepth(depth)
          pendingDirectories.push({ depth, path: childPath })
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          budget.claimFile()
          files.push(childPath)
        }
      }
    } catch (error) {
      if (error instanceof CodexSessionListingCapacityError) {
        throw error
      }
      warnAboutCodexSessionListingError(error)
    } finally {
      closeCodexSessionDirectory(directory)
    }
  }
  return files.sort()
}

function closeCodexSessionDirectory(directory: ReturnType<typeof opendirSync>): void {
  try {
    directory.closeSync()
  } catch {
    // The OS may have already closed a failed directory stream.
  }
}

/**
 * Yields session JSONL files incrementally while walking a directory tree.
 *
 * The generator yields control between batches so large history directories do
 * not monopolize startup work.
 */
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

/** Yields both physical representations that current Codex can resume. */
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
  const budget = new CodexSessionListingBudget(options.limits)
  budget.claimDepth(0)
  budget.claimPath(rootPath)
  const pendingDirectories = [{ depth: 0, path: rootPath }]
  let entriesSinceYield = 0

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop()!
    try {
      const directory = await opendir(currentDirectory.path)
      for await (const entry of directory) {
        budget.claimEntry()
        const childPath = join(currentDirectory.path, entry.name)
        budget.claimPath(childPath)
        if (entry.isDirectory()) {
          const depth = currentDirectory.depth + 1
          budget.claimDepth(depth)
          pendingDirectories.push({ depth, path: childPath })
        } else if (entry.isFile() && isSessionFile(entry.name)) {
          budget.claimFile()
          yield childPath
        }
        entriesSinceYield += 1
        if (entriesSinceYield >= batchSize) {
          entriesSinceYield = 0
          await delayIncrementalBridge(yieldMs)
        }
      }
    } catch (error) {
      await onDirectoryError?.(currentDirectory.path, error)
      warnAboutCodexSessionListingError(error)
      if (error instanceof CodexSessionListingCapacityError) {
        return
      }
    }
  }
}

function warnAboutCodexSessionListingError(error: unknown): void {
  console.warn('[codex-session-bridge] Failed to list system Codex sessions:', error)
}

/**
 * Defers incremental bridge work to a later timer turn.
 */
function delayIncrementalBridge(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
