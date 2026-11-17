import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'

/** `timeMs` starts when the worker picks the request up, not while it waits behind another walk. */
export type CodexHistoryDiskUsageBudget = { maxEntries: number; timeMs: number }

export type CodexHistoryDiskUsageWorkerRequest = {
  id: number
  homes: string[]
  budget: CodexHistoryDiskUsageBudget
}

export type CodexHistoryDiskUsageWorkerResponse =
  | { id: number; ok: true; usage: CodexHistoryDiskUsage }
  | { id: number; ok: false; error: string }
