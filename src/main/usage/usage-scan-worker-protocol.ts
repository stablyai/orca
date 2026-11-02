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

// Why (#20940): the first-party usage scans walk whole rollout/transcript
// corpora and read SQLite synchronously, all on the Electron main process. They
// share one worker thread, so this protocol is the only shape that crosses the
// boundary. It must stay electron-free — worker threads cannot require electron
// — and structured-cloneable, which is why every field is plain data.

/**
 * Providers whose scan runs on the shared usage worker. Deliberately narrower
 * than `UsageProviderId`: a `plugin:` provider supplies its own scan function,
 * which is not in this bundle and cannot be named on the wire.
 */
export type UsageScanWorkerProviderId = 'claude' | 'codex' | 'opencode' | 'muse'

/**
 * Scan body per provider. The worker reads that provider's per-source cache from
 * `sourceCache` and writes the new one back, so those records never cross to main.
 */
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

/**
 * Liveness for one in-flight scan: files (or databases) finished so far.
 *
 * Why: a corpus large enough to need minutes must not be killed for being slow,
 * but a wedged thread still has to be. The client's deadline is therefore a
 * no-progress window keyed on these, not a wall clock on the whole scan.
 */
export type UsageScanWorkerProgress = { id: number; filesScanned: number }

export type UsageScanWorkerMessage = UsageScanWorkerResponse | UsageScanWorkerProgress

export function isUsageScanWorkerProgress(message: {
  id: number
}): message is UsageScanWorkerProgress {
  return 'filesScanned' in message
}
