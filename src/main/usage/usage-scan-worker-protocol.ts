import type {
  ClaudeUsageDailyAggregate,
  ClaudeUsagePersistedFile,
  ClaudeUsageSession
} from '../claude-usage/types'
import type {
  CodexUsageDailyAggregate,
  CodexUsagePersistedFile,
  CodexUsageSession
} from '../codex-usage/types'
import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageSession
} from '../opencode-usage/types'
import type {
  MuseUsageDailyAggregate,
  MuseUsagePersistedFile,
  MuseUsageSession
} from '../muse-usage/types'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import type { ClaudeUsageScanTarget } from '../claude-usage/scanner'

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

/** Request body per provider; `previous` is that provider's own per-source cache. */
export type UsageScanWorkerRequestBody =
  | {
      providerId: 'claude'
      worktrees: UsageScanWorktreeRef[]
      previous: ClaudeUsagePersistedFile[]
      target?: ClaudeUsageScanTarget
    }
  | { providerId: 'codex'; worktrees: UsageScanWorktreeRef[]; previous: CodexUsagePersistedFile[] }
  | {
      providerId: 'opencode'
      worktrees: UsageScanWorktreeRef[]
      previous: OpenCodeUsagePersistedDatabase[]
    }
  | { providerId: 'muse'; worktrees: UsageScanWorktreeRef[]; previous: MuseUsagePersistedFile[] }

export type UsageScanWorkerRequest = UsageScanWorkerRequestBody & { id: number }

/**
 * Scan result per provider. `source` is the provider's per-source cache under a
 * uniform name: the persisted key (`processedFiles` / `processedDatabases`) is a
 * disk-format concern and each route renames it back on the main thread.
 */
export type UsageScanWorkerValue =
  | {
      providerId: 'claude'
      source: ClaudeUsagePersistedFile[]
      sessions: ClaudeUsageSession[]
      dailyAggregates: ClaudeUsageDailyAggregate[]
    }
  | {
      providerId: 'codex'
      source: CodexUsagePersistedFile[]
      sessions: CodexUsageSession[]
      dailyAggregates: CodexUsageDailyAggregate[]
    }
  | {
      providerId: 'opencode'
      source: OpenCodeUsagePersistedDatabase[]
      sessions: OpenCodeUsageSession[]
      dailyAggregates: OpenCodeUsageDailyAggregate[]
    }
  | {
      providerId: 'muse'
      source: MuseUsagePersistedFile[]
      sessions: MuseUsageSession[]
      dailyAggregates: MuseUsageDailyAggregate[]
    }

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
