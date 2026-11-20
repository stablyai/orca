import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { findOpenFiles } from '../../../filesystem/open-file-check'
import { readCodexSharedSqliteHome } from '../../configuration/toml/config-toml-shared-sqlite-home'
import type { CodexHistoryCleanupThresholds } from '../cleanup-policy/codex-history-cleanup-policy'
import { isCodexAccountHistoryLinked } from './codex-account-history-links'

export const DAY_MS = 24 * 60 * 60 * 1000
/** Busy unlinks a proven copy may fail before it is kept for good, until it changes. */
export const MAX_TRANSIENT_DELETE_FAILURES = 3

export async function readConfig(accountHome: string): Promise<string> {
  try {
    return await readFile(join(accountHome, 'config.toml'), 'utf8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return ''
    }
    throw error
  }
}

/**
 * The home's databases go only after it has worked shared long enough, over enough runs; a streak
 * not extended lately (the home unused, or a newer build gone) proves nothing current.
 */
export function hasProvenShared(
  manifest: { firstSharedAt: string | null; lastSharedAt: string | null; sharedPasses: number },
  now: number,
  thresholds: CodexHistoryCleanupThresholds<'databases'>
): boolean {
  const first = Date.parse(manifest.firstSharedAt ?? '')
  const last = Date.parse(manifest.lastSharedAt ?? '')
  return (
    Number.isFinite(first) &&
    Number.isFinite(last) &&
    now - first >= thresholds.minSharedDays * DAY_MS &&
    now - last <= thresholds.maxSinceLastSharedDays * DAY_MS &&
    manifest.sharedPasses >= thresholds.minSharedPasses
  )
}

export async function databasesUnused(accountHome: string, storeHome: string): Promise<boolean> {
  return (
    readCodexSharedSqliteHome(await readConfig(accountHome)) === storeHome &&
    (await isCodexAccountHistoryLinked(accountHome, storeHome))
  )
}

// Windows antivirus and indexers hold files briefly; such a copy is tried again next run.
export function isTransientDeleteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return process.platform === 'win32' && (code === 'EBUSY' || code === 'EPERM')
}

// Homes whose open-file check couldn't tell this run (too many processes, a slow lsof): asking
// again would repeat the same scan with the same answer, so nothing there is deleted until restart.
const openCheckUnknown = new Set<string>()
const SLOW_OPEN_CHECK_MS = 2_000

export async function openFilesOnce(
  home: string,
  targets: string[],
  shouldStop: () => boolean
): Promise<Set<string> | null> {
  if (openCheckUnknown.has(home)) {
    return null
  }
  const startedAt = Date.now()
  const open = await findOpenFiles(targets, { shouldStop })
  // Only a slow answer is remembered: a quick "can't tell" (a Codex running whose descriptors
  // can't be read) is cheap to ask again, and may well be answerable later this run.
  if (!open && !shouldStop() && Date.now() - startedAt >= SLOW_OPEN_CHECK_MS) {
    openCheckUnknown.add(home)
  }
  return open
}
