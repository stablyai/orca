import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../shared/file-write/windows-retry-file-operations'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import type { CopiesTally } from '../codex/history/shared-store/codex-account-copies-tally'
import { isTelemetryEnabled, track } from './client'

const cap = (value: number, max = 10_000_000): number =>
  Math.min(Math.max(0, Math.round(value)), max)

async function sentVersion(markerPath: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(markerPath, 'utf8'))
    return parsed &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      typeof parsed.version === 'string'
      ? parsed.version
      : null
  } catch {
    // Missing or torn: at worst one extra report.
    return null
  }
}

/** One report per install and version of the first cleanup this version ran. Never rejects. */
export async function reportCodexHistoryCopiesCleanup(
  markerPath: string,
  tally: CopiesTally & { homes: number }
): Promise<void> {
  const platform = process.platform
  if ((platform !== 'darwin' && platform !== 'win32') || !isTelemetryEnabled()) {
    return
  }
  const version = getAppEnvironment().getVersion()
  if ((await sentVersion(markerPath)) === version) {
    return
  }
  const sent = track('codex_history_copies_cleanup', {
    platform,
    homes: cap(tally.homes, 1000),
    files_trashed: cap(tally.trashed),
    mb_trashed: cap(tally.bytesTrashed / (1024 * 1024)),
    files_deleted: cap(tally.deleted),
    mb_reclaimed: cap(tally.bytesReclaimed / (1024 * 1024)),
    files_restored: cap(tally.restored),
    kept_differs: cap(tally.differs),
    kept_open: cap(tally.open),
    kept_linked: cap(tally.linked),
    kept_missing_original: cap(tally.missing_original),
    kept_changed: cap(tally.changed),
    kept_error: cap(tally.error),
    kept_compressed: cap(tally.compressed),
    kept_busy: cap(tally.busy),
    deferred: cap(tally.deferred)
  })
  if (!sent) {
    return
  }
  const staged = `${markerPath}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(markerPath), { recursive: true })
    await writeFile(staged, `${JSON.stringify({ version })}\n`)
    await renameFileWithWindowsRetryAsync(staged, markerPath)
  } catch (error) {
    await unlink(staged).catch(() => {})
    console.warn('[codex-account-history] Copies cleanup telemetry marker not saved:', error)
  }
}
