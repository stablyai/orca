import { randomUUID } from 'node:crypto'
import { link, lstat, open, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { track } from '../../../telemetry/client'
import type { CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES } from '../../../../shared/telemetry/schemas/telemetry-codex-legacy-history-event-schemas'

type LegacyHistoryImportOutcome = (typeof CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES)[number]

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return false
    }
    throw error
  }
}

// Every account's own history file, ownership marker or not: a removed or shared home keeps it.
async function listAccountHistories(accountsRoot: string): Promise<string[]> {
  const accounts = await readdir(accountsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return []
    }
    throw error
  })
  const paths: string[] = []
  for (const account of accounts.filter((entry) => entry.isDirectory())) {
    const historyPath = join(accountsRoot, account.name, 'home', 'history.jsonl')
    const stats = await lstat(historyPath).catch(() => null)
    if (stats?.isFile()) {
      paths.push(historyPath)
    }
  }
  return paths.sort()
}

/**
 * Codex may be appending to or trimming a shared history.jsonl that exists, so only a missing one
 * is created from the account histories, which are only read, and never over one Codex creates
 * meanwhile. Rejects on failure, so the migration retries on the next launch.
 */
export async function importLegacyHistoriesIfSharedAbsent(
  accountsRoot: string,
  runtimeHistoryPath: string
): Promise<void> {
  const accountHistoryPaths = await listAccountHistories(accountsRoot)
  if (accountHistoryPaths.length === 0) {
    return
  }
  let outcome: LegacyHistoryImportOutcome = 'failed'
  try {
    outcome = await publishLegacyHistoriesIfAbsent(accountHistoryPaths, runtimeHistoryPath)
  } finally {
    trackLegacyHistoryImport(outcome)
  }
}

async function publishLegacyHistoriesIfAbsent(
  accountHistoryPaths: readonly string[],
  runtimeHistoryPath: string
): Promise<LegacyHistoryImportOutcome> {
  if (await pathExists(runtimeHistoryPath)) {
    return 'skipped_existing'
  }
  const seenLines = new Set<string>()
  for (const accountHistoryPath of accountHistoryPaths) {
    for (const line of (await readFile(accountHistoryPath, 'utf-8')).split('\n')) {
      if (line) {
        seenLines.add(line)
      }
    }
  }
  if (seenLines.size === 0) {
    return 'nothing_to_import'
  }
  const contents = `${[...seenLines].join('\n')}\n`
  return (await publishWithoutOverwrite(contents, runtimeHistoryPath))
    ? 'imported'
    : 'skipped_existing'
}

async function publishWithoutOverwrite(contents: string, targetPath: string): Promise<boolean> {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmpPath, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // A hard link publishes only into a free name: one Codex created meanwhile stays as it is.
    await link(tmpPath, targetPath)
    return true
  } catch (error) {
    const code = errnoCodeOrUnknown(error)
    if (code === 'EEXIST') {
      return false
    }
    if (!HARD_LINK_UNSUPPORTED.has(code)) {
      throw error
    }
    return appendIntoNewFile(contents, targetPath)
  } finally {
    await rm(tmpPath, { force: true })
  }
}

// exFAT, FAT32 and some network or FUSE mounts refuse hard links.
const HARD_LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])

/**
 * Without hard links: exclusive create still never touches an existing file, and append mode puts
 * Orca's single write and any Codex append to the new file one after the other, never over it.
 */
async function appendIntoNewFile(contents: string, targetPath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(targetPath, 'ax', 0o600)
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'EEXIST') {
      return false
    }
    throw error
  }
  try {
    await handle.writeFile(contents, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}

function trackLegacyHistoryImport(outcome: LegacyHistoryImportOutcome): void {
  try {
    track('codex_legacy_history_import', {
      outcome,
      platform:
        process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'darwin'
    })
  } catch {
    // Telemetry never costs the migration.
  }
}
