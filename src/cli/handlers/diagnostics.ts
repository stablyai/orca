import type { MemorySnapshot } from '../../shared/process-stats-types'
import {
  clearPrivateHistoryOlderThan,
  formatPrivateHistoryClear,
  formatPrivateHistoryDisk,
  localPrivateHistoryPaths,
  measurePrivateHistoryDisk
} from '../../main/session-retention/private-history-disk'
import { readProfileWorktreeIdsForRetention } from '../../main/session-retention/profile-worktree-ids'
import { DEFAULT_PRIVATE_HISTORY_MAX_AGE_DAYS } from '../../main/session-retention/codex-session-retention'
import type { CommandHandler } from '../dispatch'
import { formatMemorySnapshot, printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'

export const DIAGNOSTICS_HANDLERS: Record<string, CommandHandler> = {
  'diagnostics memory': async ({ client, json }) => {
    const result = await client.call<MemorySnapshot>('diagnostics.memory')
    printResult(result, json, formatMemorySnapshot)
  },
  'diagnostics disk': async ({ json }) => {
    const report = await measurePrivateHistoryDisk({ ...localPrivateHistoryPaths() })
    if (json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log(formatPrivateHistoryDisk(report))
  },
  'diagnostics clear-history-older-than': async ({ flags, json }) => {
    const days = readRetentionDays(flags.get('days'))
    const dryRun = flags.get('dry-run') === true
    const paths = localPrivateHistoryPaths()
    const profiles = readProfileWorktreeIdsForRetention(paths.historyUserDataPath)
    const terminalHistorySkipReason =
      profiles.unreadableProfiles > 0
        ? 'unreadable-profiles'
        : profiles.profilesRead === 0
          ? 'no-profiles'
          : profiles.ids.size === 0
            ? 'empty-live-set'
            : null
    const result = await clearPrivateHistoryOlderThan({
      ...paths,
      days,
      dryRun,
      liveWorktreeIds: terminalHistorySkipReason ? null : profiles.ids,
      terminalHistorySkipReason
    })
    if (json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    console.log(formatPrivateHistoryClear(result))
  }
}

function readRetentionDays(value: string | boolean | undefined): number {
  if (value === undefined) {
    return DEFAULT_PRIVATE_HISTORY_MAX_AGE_DAYS
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass --days as a whole number of days, at least 1.'
    )
  }
  const days = Number(value)
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass --days as a whole number of days from 1 through 3650.'
    )
  }
  return days
}
