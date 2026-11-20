import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  runWhileNoCodexThreadIsLive,
  type LockFolderBusy
} from '../../../codex/history/shared-store/codex-thread-writer-locks'
import { track } from '../../../telemetry/client'
import type { CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES } from '../../../../shared/telemetry/schemas/telemetry-codex-legacy-history-event-schemas'

type ImportOutcome = (typeof CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES)[number]

const SKIPPED_OUTCOMES: Record<'held' | LockFolderBusy, ImportOutcome> = {
  held: 'codex_live',
  busy: 'busy',
  'no-helper': 'no_helper'
}

export type LegacyMigrationMarker = {
  completedAt?: number
  migratedHomeCount?: number
  /** Legacy prompt history still waits for a launch with no live Codex in the shared home. */
  historyPending?: true
}

function readFileVersion(path: string): string {
  try {
    const stats = statSync(path, { bigint: true })
    return `${stats.ino}:${stats.size}:${stats.mtimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent'
    }
    throw error
  }
}

/**
 * A live Codex appends to and trims history.jsonl under a lock Orca can't share, so the import runs
 * only while no Codex thread is live in the home and none can start; otherwise it stays pending for
 * the next launch.
 */
export async function importLegacyHistoryWhenNoCodexIsLive(args: {
  runtimeHomePath: string
  importHistory: () => void
}): Promise<void> {
  let outcome: ImportOutcome
  try {
    const runtimeHistoryPath = join(args.runtimeHomePath, 'history.jsonl')
    const versionBefore = readFileVersion(runtimeHistoryPath)
    const result = await runWhileNoCodexThreadIsLive(args.runtimeHomePath, () => {
      if (readFileVersion(runtimeHistoryPath) !== versionBefore) {
        return false
      }
      args.importHistory()
      return true
    })
    outcome = result.ran ? (result.value ? 'imported' : 'changed') : SKIPPED_OUTCOMES[result.reason]
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to import legacy Codex prompt history:', error)
    outcome = 'failed'
  }
  try {
    track('codex_legacy_history_import', {
      outcome,
      platform:
        process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'darwin'
    })
  } catch {
    // Telemetry never costs the import.
  }
}

/** Appends the legacy lines runtime history lacks; never rewrites what Codex already wrote. */
export function appendMissingLegacyHistory(
  legacyHistoryPath: string,
  runtimeHistoryPath: string
): void {
  const existingHistory = existsSync(runtimeHistoryPath)
    ? readFileSync(runtimeHistoryPath, 'utf-8')
    : ''
  const seenLines = new Set(existingHistory.split('\n').filter(Boolean))
  const missingLines: string[] = []
  for (const line of readFileSync(legacyHistoryPath, 'utf-8').split('\n')) {
    if (!line || seenLines.has(line)) {
      continue
    }
    seenLines.add(line)
    missingLines.push(line)
  }
  if (missingLines.length === 0) {
    return
  }
  // One write per line, each started on a fresh line, so a failed write damages only its own record.
  const fd = openSync(runtimeHistoryPath, 'a', 0o600)
  try {
    if (existingHistory && !existingHistory.endsWith('\n')) {
      writeFileSync(fd, '\n')
    }
    for (const line of missingLines) {
      try {
        writeFileSync(fd, `${line}\n`, 'utf-8')
      } catch (error) {
        try {
          writeFileSync(fd, '\n')
        } catch {
          // The original write error is the one to report.
        }
        throw error
      }
    }
  } finally {
    closeSync(fd)
  }
}
