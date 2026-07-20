import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { LocalUsageHistoryProvider } from '../../shared/local-usage-history-types'
import type {
  LocalUsageHistoryPersistedFile,
  LocalUsageHistoryScanResult,
  LocalUsageHistorySource
} from './types'
import { combineHourlyAggregates, parseUsageHistoryFile } from './history-token-parser'

const YIELD_EVERY_FILES = 10

export function getLocalUsageHistorySource(
  provider: LocalUsageHistoryProvider
): LocalUsageHistorySource {
  if (provider === 'kimi') {
    const kimiHome = process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code')
    return { provider, rootDir: join(kimiHome, 'sessions') }
  }
  return { provider, rootDir: join(homedir(), '.gemini', 'tmp') }
}

export async function scanLocalUsageHistory(args: {
  provider: LocalUsageHistoryProvider
  rootDir: string
  previousFiles: readonly LocalUsageHistoryPersistedFile[]
}): Promise<LocalUsageHistoryScanResult> {
  const filePaths = await listUsageHistoryFiles(args.provider, args.rootDir)
  const previousByPath = new Map(args.previousFiles.map((file) => [file.path, file]))
  const processedFiles: LocalUsageHistoryPersistedFile[] = []

  for (const [index, path] of filePaths.entries()) {
    const metadata = await getFileMetadata(path)
    if (!metadata) {
      continue
    }
    const previous = previousByPath.get(path)
    if (previous && previous.mtimeMs === metadata.mtimeMs && previous.size === metadata.size) {
      processedFiles.push(previous)
    } else {
      processedFiles.push({
        path,
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
        hourlyAggregates: await parseUsageHistoryFile(args.provider, path)
      })
    }
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  return {
    processedFiles,
    hourlyAggregates: combineHourlyAggregates(
      processedFiles.flatMap((file) => file.hourlyAggregates)
    )
  }
}

async function listUsageHistoryFiles(
  provider: LocalUsageHistoryProvider,
  rootDir: string
): Promise<string[]> {
  try {
    return await walkUsageHistoryFiles(provider, rootDir)
  } catch {
    // Missing local history is a normal first-run condition.
    return []
  }
}

async function walkUsageHistoryFiles(
  provider: LocalUsageHistoryProvider,
  directory: string
): Promise<string[]> {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    // One rotated or unreadable session folder must not discard its readable
    // siblings, which can otherwise look like a successful empty history scan.
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkUsageHistoryFiles(provider, path)))
    } else if (entry.isFile() && isUsageHistoryFile(provider, path)) {
      files.push(path)
    }
  }
  return files.sort()
}

async function getFileMetadata(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const metadata = await stat(path)
    return { mtimeMs: metadata.mtimeMs, size: metadata.size }
  } catch {
    // The CLI may rotate a file after discovery but before metadata is read.
    // Skip just that path and retain aggregates from every other session.
    return null
  }
}

function isUsageHistoryFile(provider: LocalUsageHistoryProvider, path: string): boolean {
  if (provider === 'kimi') {
    return basename(path) === 'wire.jsonl'
  }
  return path.endsWith('.json') || path.endsWith('.jsonl')
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}
