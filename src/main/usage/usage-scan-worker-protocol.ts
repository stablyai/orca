import type { ClaudeUsageDailyAggregate, ClaudeUsageSession } from '../claude-usage/types'
import type { CodexUsageDailyAggregate, CodexUsageSession } from '../codex-usage/types'
import type { OpenCodeUsageDailyAggregate, OpenCodeUsageSession } from '../opencode-usage/types'
import type { MuseUsageDailyAggregate, MuseUsageSession } from '../muse-usage/types'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import type {
  UsageCacheSplitRequest,
  UsageCacheSplitResult,
  UsageSourceCacheRef
} from './usage-source-cache-file'

// #20940: synchronous history/SQLite scans share one worker. Keep this boundary Electron-free and structured-cloneable plain data.

/** Plugin providers supply their own scan functions and cannot be named in this bundled-worker protocol. */
export type UsageScanWorkerProviderId = 'claude' | 'codex' | 'opencode' | 'muse'

/** Worker-owned sourceCache records never cross to main. */
export type UsageScanWorkerScanBody =
  | {
      operation: 'scan'
      providerId: 'claude'
      profileDirs?: string[]
      worktrees: UsageScanWorktreeRef[]
      sourceCache: UsageSourceCacheRef
    }
  | {
      operation: 'scan'
      providerId: 'codex'
      worktrees: UsageScanWorktreeRef[]
      sourceCache: UsageSourceCacheRef
    }
  | {
      operation: 'scan'
      providerId: 'opencode'
      worktrees: UsageScanWorktreeRef[]
      sourceCache: UsageSourceCacheRef
    }
  | {
      operation: 'scan'
      providerId: 'muse'
      worktrees: UsageScanWorktreeRef[]
      sourceCache: UsageSourceCacheRef
    }

export type UsageScanWorkerRequestBody =
  | UsageScanWorkerScanBody
  | ({ operation: 'splitCacheFile' } & UsageCacheSplitRequest)

export type UsageScanWorkerRequest = UsageScanWorkerRequestBody & { id: number }

/** Scan result per provider: only the projections main reports from. */
export type UsageScanWorkerScanValue =
  | {
      operation: 'scan'
      providerId: 'claude'
      sessions: ClaudeUsageSession[]
      dailyAggregates: ClaudeUsageDailyAggregate[]
    }
  | {
      operation: 'scan'
      providerId: 'codex'
      sessions: CodexUsageSession[]
      dailyAggregates: CodexUsageDailyAggregate[]
    }
  | {
      operation: 'scan'
      providerId: 'opencode'
      sessions: OpenCodeUsageSession[]
      dailyAggregates: OpenCodeUsageDailyAggregate[]
    }
  | {
      operation: 'scan'
      providerId: 'muse'
      sessions: MuseUsageSession[]
      dailyAggregates: MuseUsageDailyAggregate[]
    }

export type UsageScanWorkerValue =
  | UsageScanWorkerScanValue
  | ({ operation: 'splitCacheFile' } & UsageCacheSplitResult)

export type UsageScanWorkerResponse =
  | { id: number; ok: true; value: UsageScanWorkerValue }
  | { id: number; ok: false; error: string }

/** Files/databases finished for one request; reset the no-progress deadline so slow advancing scans survive while wedged threads time out. */
export type UsageScanWorkerProgress = { id: number; filesScanned: number }

export type UsageScanWorkerMessage = UsageScanWorkerResponse | UsageScanWorkerProgress

export function isUsageScanWorkerProgress(message: {
  id: number
}): message is UsageScanWorkerProgress {
  return 'filesScanned' in message
}
