import { randomUUID } from 'node:crypto'
import { link, lstat, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { track } from '../../../telemetry/client'
import { isHardLinkUnsupportedError } from '../../../codex/history/rollouts/codex-rollout-copy'
import type { CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES } from '../../../../shared/telemetry/schemas/telemetry-codex-legacy-history-event-schemas'

type LegacyHistoryImportOutcome = (typeof CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES)[number]

/** Stats only: cheap enough to ask at every launch whether the account histories changed. */
export async function legacyHistoryInputsKey(accountsRoot: string): Promise<string> {
  const parts: string[] = []
  for (const historyPath of await listAccountHistories(accountsRoot)) {
    const stats = await stat(historyPath)
    parts.push(`${historyPath}:${stats.size}:${stats.mtimeMs}`)
  }
  return parts.join('|')
}

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
    // Followed through a link, as Codex reads it. Only an absent file, no home folder or a link loop
    // means no history; any other error retries rather than skip an account.
    const stats = await stat(historyPath).catch((error: unknown) => {
      const code = errnoCodeOrUnknown(error)
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
        return null
      }
      throw error
    })
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
  return publishWithoutOverwrite(`${[...seenLines].join('\n')}\n`, runtimeHistoryPath)
}

async function publishWithoutOverwrite(
  contents: string,
  targetPath: string
): Promise<LegacyHistoryImportOutcome> {
  await removeStaleImportCopies(targetPath)
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}${IMPORT_COPY_SUFFIX}`
  try {
    const handle = await open(tmpPath, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return await linkIntoFreeName(tmpPath, targetPath)
  } finally {
    await rm(tmpPath, { force: true })
  }
}

const IMPORT_COPY_SUFFIX = '.orca-import.tmp'

// Copies an attempt a quit cut short left behind. Only regular files: removing one only drops that
// name, even when it is a hard link to the published history.
async function removeStaleImportCopies(targetPath: string): Promise<void> {
  const prefix = `${basename(targetPath)}.`
  for (const entry of await readdir(dirname(targetPath), { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.startsWith(prefix) &&
      entry.name.endsWith(IMPORT_COPY_SUFFIX)
    ) {
      await rm(join(dirname(targetPath), entry.name), { force: true })
    }
  }
}

// A hard link publishes only into a free name: one Codex created meanwhile stays as it is.
async function linkIntoFreeName(
  tmpPath: string,
  targetPath: string
): Promise<LegacyHistoryImportOutcome> {
  try {
    await link(tmpPath, targetPath)
    return 'imported'
  } catch (error) {
    const code = errnoCodeOrUnknown(error)
    if (code === 'EEXIST') {
      return 'skipped_existing'
    }
    // No safe way to publish without replacing: every other way leaves a name Codex can append
    // into mid-write. The account histories stay in their homes, so nothing is lost, and the import
    // settles rather than retry on a filesystem that won't change.
    if (isHardLinkUnsupportedError(error)) {
      return 'skipped_no_hard_links'
    }
    throw error
  }
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
