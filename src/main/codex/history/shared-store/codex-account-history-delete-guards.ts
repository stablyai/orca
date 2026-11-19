import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { findOpenFiles } from '../../../filesystem/open-file-check'
import { readCodexSharedSqliteHome } from '../../configuration/toml/config-toml-shared-sqlite-home'
import { isCodexAccountHistoryLinked } from './codex-account-history-links'

export const DAY_MS = 24 * 60 * 60 * 1000
/** The home's databases go only after it has worked shared this long, over this many runs. */
export const CLEANUP_MIN_SHARED_DAYS = 14
export const CLEANUP_MIN_SHARED_PASSES = 5
// A streak not extended lately (the home unused, or a newer build gone) proves nothing current.
const CLEANUP_MAX_SINCE_LAST_SHARED_DAYS = 30

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

export function hasProvenShared(
  manifest: { firstSharedAt: string | null; lastSharedAt: string | null; sharedPasses: number },
  now: number
): boolean {
  const first = Date.parse(manifest.firstSharedAt ?? '')
  const last = Date.parse(manifest.lastSharedAt ?? '')
  return (
    Number.isFinite(first) &&
    Number.isFinite(last) &&
    now - first >= CLEANUP_MIN_SHARED_DAYS * DAY_MS &&
    now - last <= CLEANUP_MAX_SINCE_LAST_SHARED_DAYS * DAY_MS &&
    manifest.sharedPasses >= CLEANUP_MIN_SHARED_PASSES
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

export async function openFilesOnce(
  home: string,
  targets: string[],
  shouldStop: () => boolean
): Promise<Set<string> | null> {
  if (openCheckUnknown.has(home)) {
    return null
  }
  const open = await findOpenFiles(targets, { shouldStop })
  if (!open && !shouldStop()) {
    openCheckUnknown.add(home)
  }
  return open
}
